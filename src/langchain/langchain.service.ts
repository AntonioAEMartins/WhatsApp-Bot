// src/langchain/langchain.service.ts
import { HttpException, HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import * as fs from 'fs';
import { PaymentProofDTO } from 'src/whatsapp/dto/conversation.dto';

@Injectable()
export class LangchainService {

    private chatModel: ChatOpenAI;
    private readonly url: string;

    constructor(private configService: ConfigService) {
        this.chatModel = new ChatOpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            modelName: 'gpt-4o-mini-2024-07-18',
            temperature: 0.0,
        });
        this.url = process.env.POS_BACKEND_URL;
        console.log('LangChaing URL:', this.url);
    }

    public async analyzeDocument(
        extractedText: string,
        targetPrice: number
    ): Promise<any> {
        try {
            const message = new HumanMessage({
                content: `
                Responda somente em JSON.
                Baseado no texto extraído do documento, preencha as informações do JSON abaixo:

                {
                    "nome_pagador": String,
                    "cpf_cnpj_pagador": String,
                    "instiuicao_bancaria": String,
                    "valor": Number,
                    "data_pagamento": String,
                    "nome_beneficiario": String,
                    "cpf_cnpj_beneficiario": String,
                    "instiuicao_bancaria_beneficiario": String,
                    "id_transacao": String
                }

                Se não for possível preencher todas as informações, deixe-as como null.
                Texto extraído:
                ${extractedText}
            `
            });

            const response = await this.chatModel.invoke([message]);

            // Clean up the response to extract only the JSON part
            let responseContent = response.content.toString();
            responseContent = responseContent.replace(/```json|```/g, '').trim();
            const jsonResponse: PaymentProofDTO = JSON.parse(responseContent);

            return jsonResponse;

        } catch (error) {
            console.error('Error analyzing document:', error);
            throw new HttpException('Failed to analyze document', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }



    async extractTextFromPDF(base64Data: string): Promise<any> {
        const response = await fetch(`${this.url}/extract_text_from_image`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ image_base64: base64Data }),
        });

        if (!response.ok) {
            throw new Error('Failed to extract text from PDF');
        }

        const { extracted_text } = await response.json();
        return extracted_text;
    }

    // Helper function to read the file and convert it to base64
    private encodeFileToBase64(filePath: string): string {
        const file = fs.readFileSync(filePath);
        return file.toString('base64');
    }

    // Testing function to read the PDF and analyze it
    public async testAnalyzePDF() {
        const filePath = './src/langchain/extract.PDF'; // Ensure the path is correct
        const base64Data = this.encodeFileToBase64(filePath);
        const result = await this.extractTextFromPDF(base64Data);
        return result;
    }

}