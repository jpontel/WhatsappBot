const axios = require('axios');
const { format } = require('node:path');

const ENDPOINTS = {
  USER_TOP_ALBUMS: "user.getTopAlbums",
  USER_TOP_ARTISTS: "user.getTopArtists",
  USER_TOP_TRACKS: "user.getTopTracks",
  USER_TOP_TAGS: "user.getTopTags",
  USER_WEEKLY_TRACK_CHART: "user.getWeeklyTrackChart",
  USER_INFO: "user.getInfo",
  CHART_TOP_TRACKS: "chart.getTopTracks"
};

const LASTFM_DEFAULT_IMAGE = '2a96cbd8b46e442fc41c2b86b821562f';

class LastfmService {
    async recuperarAlbumsMaisOuvidosSemana(usuario, limite = 25) {
        let data;

        try {
            const topAlbumsRecuperados = await axios.get(process.env.LASTFM_API_URL, {
                params: {
                    method: ENDPOINTS.USER_TOP_ALBUMS,
                    user: usuario,
                    limit: limite,
                    period: '7day',
                    api_key: process.env.LASTFM_API_KEY,
                    format: 'json'                
                },
            });

            data = topAlbumsRecuperados.data;

        } catch (error) {
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

        const albunsMapeados = await Promise.all(albums.map(async (album) => {
            const nome = album.name;
            const artista = album.artist.name;
            
            let imageUrl = album.image?.find((i) => i.size === 'extralarge')?.['#text'] 
                        || album.image?.[3]?.['#text'] 
                        || album.image?.[2]?.['#text']
                        || null;

            const imagemInvalida = !imageUrl || imageUrl.trim() === '' || imageUrl.includes(LASTFM_DEFAULT_IMAGE);

            if(imagemInvalida) {

                console.log(`Imagem do albúm ${nome} não encontrada. Buscando no itunes...`);
                const capaItunes = await this.buscarCapaItunes(artista, nome);

                imageUrl = capaItunes ? capaItunes : null;

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

    async listarMaisOuvidasSemana(usuario) {
        if(!usuario)
            throw new Error("Usuário não informado!");

        let data;
        try {

            const hoje = new Date();
            const seteDiasAtras = new Date();
            seteDiasAtras.setDate(hoje.getDate() - 7);

            const to = Math.floor(hoje.getTime() / 1000);
            const from = Math.floor(seteDiasAtras.getTime() / 1000);

            const maisOuvidas = await axios.get(process.env.LASTFM_API_URL, {
                params: {
                    method: ENDPOINTS.USER_WEEKLY_TRACK_CHART,
                    user: usuario,
                    from:from,
                    to: to,
                    limit: 10,
                    api_key: process.env.LASTFM_API_KEY,
                    format: 'json'  
                }
            });

            data = maisOuvidas.data;
            
        } catch (error) {
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

    async buscarCapaItunes(artista, album) {
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
}

module.exports = new LastfmService();
