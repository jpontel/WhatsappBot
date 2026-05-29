import { Canvas } from '../utils/canvas.js';
import { LastfmService } from '../services/lastfm.service.js';
import type { ComandoExecutarDto } from '../dto/comandos.dto.js';

export default {
    name: '/semaninha',
    description: 'Cria a semaninha do Last.fm',
    
    execute: async (comandoExecutarDto: ComandoExecutarDto) => {
        const { sock, msg, usuarioJid } = comandoExecutarDto;

        const usuario = comandoExecutarDto.conteudo;

        if(!usuario) {

            return await sock.sendMessage(usuarioJid, { 
                text: "semaninha de quem?! ;p",
                react: { text: '❌', key: msg.key } 
            });

        }

        try {
            await sock.sendMessage(usuarioJid, {
                react: { text: '⏳', key: msg.key }
            });

            const canvas = new Canvas();
            const lastfmsService = new LastfmService();

            const albums = await lastfmsService.recuperarAlbumsMaisOuvidosSemana(usuario);

            const semaninha = await canvas.criarCanvas(albums);

            await sock.sendMessage(usuarioJid, {
                react: { text: '✅', key: msg.key }
            });

            await sock.sendMessage(usuarioJid, {
                image: semaninha,
                mimetype: 'image/jpeg',
                caption: `Semaninha do ${usuario}`
            });

        } catch (error) {

            if(error instanceof Error) {
                
                console.error(error.message);
                
                return await sock.sendMessage(usuarioJid, { 
                    text: `Ixe, deu ruim 😝 - [Log]: ${error.message}`,
                    react: { text: '❌', key: msg.key } 
                });

            } else {
                return await sock.sendMessage(usuarioJid, { 
                    text: "❌❌ deu ruim >< ❌❌",
                    react: { text: '❌', key: msg.key } 
                });
            }
        }
    }
}