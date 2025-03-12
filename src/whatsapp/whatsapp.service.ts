import { Injectable, HttpException, HttpStatus, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookVerificationDto } from './dto/webhook.verification.dto';
import { WebhookNotificationDto } from './dto/webhook.notification.dto';
import { WhatsAppConfig } from './dto/whatsapp.config.interface';
import { lastValueFrom } from 'rxjs';
import { MessageService, RequestStructure, ResponseStructureExtended } from 'src/message/message.service';
import { HttpService } from '@nestjs/axios';
import { WhatsAppApiService } from 'src/shared/whatsapp.api.service';
@Injectable()
export class WhatsAppService {
    private readonly whatsappConfig: WhatsAppConfig;
    private readonly phoneNumberId: string;
    private readonly accessToken: string;
    private readonly graphApiUrl: string;

    constructor(
        private readonly configService: ConfigService,
        @Inject(forwardRef(() => MessageService)) private readonly messageService: MessageService,
        private readonly httpService: HttpService,
        private readonly whatsappApi: WhatsAppApiService
    ) {
        this.whatsappConfig = {
            verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
        };
        this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
        this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        this.graphApiUrl = `https://graph.facebook.com/v22.0`;
    }

    handleWebhookVerification(query: WebhookVerificationDto): string {
        if (
            query.mode === 'subscribe' &&
            query.verifyToken === this.whatsappConfig.verifyToken
        ) {
            console.log('Webhook verified');
            return query.challenge;
        } else {
            throw new Error('Webhook verification failed');
        }
    }

    async processWebhookNotification(notification: WebhookNotificationDto): Promise<void> {
        for (const entry of notification.entry) {
            for (const change of entry.changes) {
                switch (change.field) {
                    case 'messages':
                        await this.handleMessageNotification(change.value);
                        break;
                    case 'statuses':
                        await this.handleStatusNotification(change.value);
                        break;
                }
            }
        }
    }

    private async handleMessageNotification(value: any): Promise<void> {
        // console.log('Processing message notification:', value);

        const { messages = [] } = value;
        for (const message of messages) {
            const requestStructure: RequestStructure = this.parseMessage(message);
            // console.log('Request structure:', requestStructure);
            const result = await this.messageService.handleProcessMessage(requestStructure);
            await this.whatsappApi.sendWhatsAppMessages(result);
        }
    }

    private async handleStatusNotification(value: any): Promise<void> {
        // console.log('Processing status notification:', value);
    }

    private parseMessage(message: any): RequestStructure {
        const { from, type } = message;

        let parsedType: 'image' | 'text' | 'vcard' | 'document' = 'text';
        let content = '';

        switch (type) {
            case 'text':
                parsedType = 'text';
                content = message.text?.body || '';
                break;
            case 'image':
                parsedType = 'image';
                content = message.image?.link || '';
                break;
            case 'document':
                parsedType = 'document';
                content = message.document?.link || '';
                break;
            case 'contacts':
                parsedType = 'vcard';
                content = JSON.stringify(message.contacts || []);
                break;
            default:
                parsedType = 'text';
                content = 'Mensagem de tipo desconhecido';
        }

        return {
            from,
            type: parsedType,
            content,
        };
    }
}