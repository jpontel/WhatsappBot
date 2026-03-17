const { GoogleGenAI } = require("@google/genai");
const db = require('../config/database');

class GoogleCloudService {

    constructor() {
        this.ai = new GoogleGenAI({});
        this.model = "gemini-3-flash-preview";
        this.systemInstructions = `
        [ROLE]: Você é um agente especializado em responder perguntas a curiosidades e gerar mensagens com tom irônico, cômico e afrontoso. 
        
        [INSTRUCTIONS]: 
        1. Mantenha o foco exclusivamente em responder à dúvida do usuário, aplicando a formatação de texto do WhatsApp (Linguagem Markdown do WhatsApp) de forma silenciosa e natural em toda a sua resposta.
        2. Regra de gatilho para a 'bettdopo': Aborde que você só a vê em dias de grande tempestade e trovoadas (pois ela ama trovões) EXCLUSIVAMENTE se a mensagem do usuário mencionar "bettdopo" ou falar sobre "trovões". Caso esses temas não apareçam, ignore a existência dela.
        3. Enriqueça a geração dos textos com uma variedade expressiva de emojis (animais, reações, corações, etc.). 

        [DIRETRIZES DE VOCABULÁRIO]:
        4. Dicionário de termos específicos: 
        a) gag: Quando quiser expressar surpresa sobre algo (Ex: "Fiquei gag com uma info dessa"); 
        b) old bbs: Quando quiser informar que algo é obvio/concordar/dar ênfase; 
        c) avisa: Quando quer deixar explicitamente que algo foi um fecho; 
        d) fecho: Sinônimo para lacre; 
        e) de gag em gag a galinha enche o papo: Referência à humildade na construção dos passos da vida.

        5. AUTONOMIA E CONTEXTO: Use o dicionário acima com extrema moderação e naturalidade. Selecione entre 0 a no máximo 2 termos por mensagem, e apenas se o contexto da conversa implorar por isso. Se a situação não pedir gírias, responda com o seu tom irônico natural sem utilizar nenhuma palavra do dicionário.
        `;
    }

    _recuperarHistorico(chatId, limite = 10) {
        const mensagensRecuperar = db.prepare(`
            select role, content
            from (
                select role, content, timestamp
                from mensagens
                where chat_id = ?
                order by timestamp desc
                limit ?
            )
            order by timestamp asc
        `);

        const mensagensHistorico = mensagensRecuperar.all(chatId, limite);

        return mensagensHistorico.map(msg => ({
            role: msg.role,
            parts: [{text: msg.content}],
        }));
    }

    _salvarMensagem(chatId, role, content) {
        const alterarMensagem = db.prepare(`
            insert into mensagens(chat_id, role, content)
            values (?, ?, ?)    
        `)

        alterarMensagem.run(chatId, role, content);
    }

    async gerarConteudo(gerarConteudoDto) {

       if(gerarConteudoDto.chatId) {
            const historico = this._recuperarHistorico(gerarConteudoDto.chatId);

            const startTime = Date.now();
            console.log(`[CONTEÚDO] Iniciando geração de texto.`);

            const chatSession = this.ai.chats.create({
                model: this.model,
                config: {
                    systemInstruction: this.systemInstructions
                },
                history: historico
            });

            const parts = [];

            if(gerarConteudoDto.content)
                parts.push({ text: gerarConteudoDto.content });

            if(gerarConteudoDto.media) {

                parts.push({
                    inlineData: {
                        data: gerarConteudoDto.media.data,
                        mimeType: gerarConteudoDto.media.mimetype
                    }
                });
                
            }

            const result = await chatSession.sendMessage({
                message: parts
            });
            const response = result.text;

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`[CONTEÚDO] Sucesso! Finalizado em ${elapsed} segundos.`);

            this._salvarMensagem(gerarConteudoDto.chatId, 'user', gerarConteudoDto.content);
            this._salvarMensagem(gerarConteudoDto.chatId, 'model', response);

            return response;

        } else {
            const response = await this.ai.models.generateContent({
                model: "gemini-3-flash-preview",
                contents: gerarConteudoDto.content,
                config: {
                    systemInstruction: this.systemInstructions
                }
            });

            return response.text;
        }

    }    

    async gerarMidia(gerarMidiaDto) {
        
        if(gerarMidiaDto.type === "imagem") {

            const startTime = Date.now();
            console.log(`[IMAGEM] Iniciando geração.`);

            const response = await this.ai.models.generateContent({
                model: 'gemini-3.1-flash-image-preview',
                contents: `Gere uma imagem sobre: ${gerarMidiaDto.content}`,
                config: {
                    imageConfig: {
                        imageSize: "512px", 
                        aspectRatio: "1:1"  
                    }
                }
            });

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`[IMAGEM] Sucesso! Finalizado em ${elapsed} segundos.`);

            const parts = response.candidates[0].content.parts;
            const imagePart = parts.find(part => part.inlineData);

            if (!imagePart) {
                const textPart = parts.find(part => part.text);
                const mensagem = textPart ? textPart.text : "A IA não retornou imagem (possível filtro de segurança).";
                throw new Error(`Falha ao gerar imagem: ${mensagem}`);
            }

            return imagePart.inlineData.data;
        }

        if(gerarMidiaDto.type === "video") {
            
            const startTime = Date.now();
            console.log(`[VÍDEO] Iniciando geração.`);

            let operation = await this.ai.models.generateVideos({
                model: 'veo-3.1-fast-generate-preview',
                prompt: `Gere um vídeo sobre: ${gerarMidiaDto.content}`,
                config: {
                    durationSeconds: 6,
                    aspectRatio: '9:16'
                }
            });

            while(!operation.done) {
                await new Promise((resolve) => setTimeout(resolve, 5000));
                operation = await this.ai.operations.getVideosOperation({ operation });
            }

            if (operation.error || !operation.response?.generatedVideos?.length) {
                const erroDetalhado = operation.error ? JSON.stringify(operation.error) : "Bloqueado pelo filtro de segurança (Pessoas reais, violência ou violação de políticas).";
                throw new Error(`A API do Veo recusou o vídeo. Motivo: ${erroDetalhado}`);
            }
            const arquivoVideo = operation.response.generatedVideos[0].video;

            const video = await fetch(arquivoVideo.uri, {
                headers: {"x-goog-api-key": process.env.GEMINI_API_KEY}
            });

            const buffer = await video.arrayBuffer();
            
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`[VÍDEO] Sucesso! Finalizado em ${elapsed} segundos.`);

            return Buffer.from(buffer).toString("base64");
        }
        
    }
    
}

module.exports = new GoogleCloudService();
