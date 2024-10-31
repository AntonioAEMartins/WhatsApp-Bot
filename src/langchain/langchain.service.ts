// src/langchain/langchain.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import * as fs from 'fs';

@Injectable()
export class LangchainService {

    private chatModel: ChatOpenAI;

    constructor(private configService: ConfigService) {
        this.chatModel = new ChatOpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            modelName: 'gpt-4o-mini-2024-07-18',
            temperature: 0.0,
        });
    }

    private async helloWorld() {
        try {
            const response: AIMessageChunk = await this.chatModel.invoke("Hello world!");
            console.log(response.content);
        } catch (error) {
            console.error(error);
        }
    }

    // Function to analyze base64 image and compare price
    public async analyzeDocument(base64Data: string, targetPrice: number): Promise<{ isAbove: boolean; isRight: boolean; error?: string }> {
        try {
            // Determine the MIME type based on the base64 string
            const mimeType = this.getMimeType(base64Data);

            const message = new HumanMessage({
                content: [
                    {
                        type: 'text',
                        text: `
                        Responda somente em JSON.
                        Baseado no documento que você recebeu, preencha as informações do JSON abaixo:
    
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
                        `
                    },
                    {
                        image_url: {
                            url: `data:${mimeType};base64,${base64Data}`,
                        },
                        type: "image_url",
                    }
                ]
            });

            const response = await this.chatModel.invoke([message]);

            // Clean up the response to extract only the JSON part
            let responseContent = response.content.toString();

            // Regex to remove markdown code fences and other extraneous characters
            responseContent = responseContent.replace(/```json|```/g, '').trim();

            // Parse the cleaned-up JSON response from the model
            const jsonResponse = JSON.parse(responseContent);

            return jsonResponse;

        } catch (error) {
            console.error('Error analyzing document:', error);
            // Return JSON response indicating failure
            return {
                isAbove: false,
                isRight: false,
                error: 'Failed to analyze document'
            };
        }
    }


    // Helper function to detect the MIME type from the base64 string
    private getMimeType(base64Data: string): string {
        if (base64Data.startsWith("JVBERi0")) {
            return 'application/pdf'; // PDF
        } else if (base64Data.startsWith("/9j/")) {
            return 'image/jpeg'; // JPEG
        } else if (base64Data.startsWith("iVBORw0KGgo")) {
            return 'image/png'; // PNG
        } else if (base64Data.startsWith("R0lGODdh") || base64Data.startsWith("R0lGODlh")) {
            return 'image/gif'; // GIF
        } else if (base64Data.startsWith("UklGR")) {
            return 'image/webp'; // WebP
        } else {
            throw new Error('Unsupported file type');
        }
    }

    // Helper function to read the file and convert it to base64
    private encodeFileToBase64(filePath: string): string {
        const file = fs.readFileSync(filePath);
        return file.toString('base64');
    }

    // Testing function to read the PDF and analyze it
    public async testAnalyzePDF() {
        const filePath = './src/langchain/extract.JPG'; // Ensure the path is correct
        const base64Data = this.encodeFileToBase64(filePath);
        const targetPrice = 167.83;

        const result = await this.analyzeDocument(base64Data, targetPrice);
        console.log(result);
    }

}