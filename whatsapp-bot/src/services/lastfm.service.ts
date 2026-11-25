import axios from 'axios';
import { ENV } from '../config/env.js';

export class LastfmService {
    
    private lastfmApi: string;
    private endpoints: Record<string, string>;
    private lastfmDefaultImage: string;

    constructor() {
        this.lastfmApi = ENV.LASTFM_API_URL ?? "https://ws.audioscrobbler.com/2.0/";
        this.lastfmDefaultImage = "2a96cbd8b46e442fc41c2b86b821562f";

        this.endpoints = {
            USER_TOP_ALBUMS: "user.getTopAlbums",
            USER_TOP_ARTISTS: "user.getTopArtists",
            USER_TOP_TRACKS: "user.getTopTracks",
            USER_TOP_TAGS: "user.getTopTags",
            USER_WEEKLY_TRACK_CHART: "user.getWeeklyTrackChart",
            USER_INFO: "user.getInfo",
            CHART_TOP_TRACKS: "chart.getTopTracks"
        }
    }

    async recuperarAlbumsMaisOuvidosSemana(usuario: string, limite = 25) {
        let data;

        try {
            const topAlbumsRecuperados = await axios.get(this.lastfmApi, {
                params: {
                    method: this.endpoints.USER_TOP_ALBUMS,
                    user: usuario,
                    limit: limite,
                    period: '7day',
                    api_key: ENV.LASTFM_API_KEY,
                    format: 'json'                
                },
            });

            data = topAlbumsRecuperados.data;

        } catch (error: any) {
            if (error.response) {
                if (error.response.status === 404) {
                    throw new Error(`Não achei o ${usuario} no Lastfm! ><`);
                }
                
                throw new Error(`O Lastfm retornou um erro ${error.response.status}: ${error.response.data?.message || 'Desconhecido'}`);

            } else if (error.request) {

                throw new Error('Lastfm não respondeu 🤯');

            } else {
                throw new Error(`Erro no código!!!!🤯🤯 ${error.message}`);
            }
        }

        const albums = data.topalbums?.album ?? [];

        const albunsMapeados = await Promise.all(albums.map(async (album: { name: any; artist: { name: any; }; image: any[]; playcount: any; }) => {
            const nome = album.name;
            const artista = album.artist.name;
            
            let imageUrl = album.image?.find((i: { size: string; }) => i.size === 'extralarge')?.['#text'] 
                        || album.image?.[3]?.['#text'] 
                        || album.image?.[2]?.['#text']
                        || null;

            const imagemInvalida = !imageUrl || imageUrl.trim() === '' || imageUrl.includes(this.lastfmDefaultImage);

            if(imagemInvalida) {

                // Cascata de fallback: Last.fm (sem capa) → iTunes → Deezer. O
                // Deezer (API pública, sem chave) tem boa cobertura de clássico/
                // trilha/edições verbosas, justo onde o iTunes costuma falhar.
                console.log(`Imagem do albúm ${nome} não encontrada. Buscando no itunes/deezer...`);
                imageUrl = await this.buscarCapaItunes(artista, nome)
                        || await this.buscarCapaDeezer(artista, nome)
                        || null;

                console.log(imageUrl
                    ? `Capa de "${nome}" recuperada! ✅`
                    : `Sem capa pra "${nome}" em nenhuma fonte ✋`);

            }

            return {
                name: nome,
                artist: artista,
                playcount: Number(album.playcount),
                imageUrl: imageUrl
            };
        }));

        return albunsMapeados;
    }

    async listarMaisOuvidasSemana(usuario: any) {
        if(!usuario)
            throw new Error("Usuário não informado!");

        let data;
        try {

            const hoje = new Date();
            const seteDiasAtras = new Date();
            seteDiasAtras.setDate(hoje.getDate() - 7);

            const to = Math.floor(hoje.getTime() / 1000);
            const from = Math.floor(seteDiasAtras.getTime() / 1000);

            const maisOuvidas = await axios.get(this.lastfmApi, {
                params: {
                    method: this.endpoints.USER_WEEKLY_TRACK_CHART,
                    user: usuario,
                    from:from,
                    to: to,
                    limit: 10,
                    api_key: ENV.LASTFM_API_KEY,
                    format: 'json'  
                }
            });

            data = maisOuvidas.data;
            
        } catch (error: any) {
            if (error.response) {
                if (error.response.status === 404) {
                    throw new Error(`Não achei o ${usuario} no Lastfm! ><`);
                }
                
                throw new Error(`O Lastfm retornou um erro ${error.response.status}: ${error.response.data?.message || 'desconhecido'}`);

            } else if (error.request) {

                throw new Error('Lastfm não respondeu 🤯');

            } else {
                throw new Error(`Erro no código!!!!🤯🤯 ${error.message}`);
            }
        }

        let tracks = [];

        for(const track of data.weeklytrackchart.track) {
            tracks.push({
                musica: track.name,
                artista: track.artist['#text'], 
                contagem: Number(track.playcount), 
                posicao: Number(track['@attr']?.rank)
            });
        }

        return tracks;

    }

    async buscarCapaItunes(artista: any, album: any) {
        try {
            const recuperarAlbum = encodeURIComponent(`${artista} ${album}`);
            const { data } = await axios.get(`https://itunes.apple.com/search?term=${recuperarAlbum}&entity=album&limit=1`);

            if (data.results && data.results.length > 0) {
                const artworkUrl = data.results[0].artworkUrl100;
                return artworkUrl.replace(/100x100bb\.jpg$/, '600x600bb.jpg');
            }

            console.log("Album não encontrado no itunes X_X");
            return null;
        } catch (error) {
            return null;
        }
    }

    async buscarCapaDeezer(artista: any, album: any) {
        try {
            // Termo plano (artista + álbum): o ranking do Deezer casa melhor assim
            // do que com match exato `album:"..."` (que falha em título verboso).
            const q = encodeURIComponent(`${artista} ${album}`);
            const { data } = await axios.get(`https://api.deezer.com/search/album?q=${q}&limit=1`);

            const capa = data?.data?.[0];
            if (capa) {
                return capa.cover_xl || capa.cover_big || capa.cover_medium || null;
            }

            console.log("Album não encontrado no deezer X_X");
            return null;
        } catch (error) {
            return null;
        }
    }
}