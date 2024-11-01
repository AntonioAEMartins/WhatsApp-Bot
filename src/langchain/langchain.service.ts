// src/langchain/langchain.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import { pdfToPng } from 'pdf-to-png-converter';
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

    private async convertPdfToPng(base64Data: string): Promise<string[]> {
        const pdfBuffer = Buffer.from(base64Data, 'base64');

        const pngPages = await pdfToPng(pdfBuffer, {
            viewportScale: 2.0, // Scale to improve image quality
            outputFolder: './temp_pngs', // Folder to store PNGs temporarily
            outputFileMaskFunc: (pageNumber) => `page_${pageNumber}`
        });

        // Collect PNG paths
        return pngPages.map((page) => page.path);
    }

    // Function to analyze base64 image and compare price
    public async analyzeDocument(base64Data: string, targetPrice: number): Promise<{ isAbove: boolean; isRight: boolean; error?: string }> {
        try {
            const mimeType = this.getMimeType(base64Data);

            // Convert PDF to PNG if necessary
            let imagePaths: string[] = [];
            if (mimeType === 'application/pdf') {
                imagePaths = await this.convertPdfToPng(base64Data);
            } else {
                imagePaths.push(`data:${mimeType};base64,${base64Data}`);
            }

            // Prepare message with each image for analysis
            const messages = imagePaths.map(path => new HumanMessage({
                content: [
                    {
                        type: 'text',
                        text: `Please analyze this document and provide details in JSON format.`,
                    },
                    {
                        image_url: {
                            url: path.startsWith('data:') ? path : `file://${path}`,
                        },
                        type: "image_url",
                    }
                ]
            }));

            // Invoke chat model for each page or image
            const responses = await Promise.all(messages.map(message => this.chatModel.invoke([message])));

            // Process responses
            const results = responses.map(response => {
                let responseContent = response.content.toString().replace(/```json|```/g, '').trim();
                return JSON.parse(responseContent);
            });

            return results[0];  // Returning the first result for simplicity

        } catch (error) {
            console.error('Error analyzing document:', error);
            return { isAbove: false, isRight: false, error: 'Failed to analyze document' };
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
        const targetPrice = 86.25;

        const result = await this.analyzeDocument(base64Data, targetPrice);
        console.log(result);
    }

}