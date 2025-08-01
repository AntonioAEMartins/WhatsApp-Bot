import { Injectable, HttpException, HttpStatus, Inject, forwardRef, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookVerificationDto } from './dto/webhook.verification.dto';
import { WebhookNotificationDto, WhatsAppWebhookDto as WebhookFlowNotificationDto } from './dto/webhook.notification.dto';
import { WhatsAppConfig } from './dto/whatsapp.config.interface';
import { lastValueFrom } from 'rxjs';
import { MessageService, RequestStructure, ResponseStructureExtended } from 'src/message/message.service';
import { HttpService } from '@nestjs/axios';
import { WhatsAppApiService } from 'src/shared/whatsapp-api/whatsapp.api.service';
import { UserPaymentCreditInfoDto } from 'src/payment-gateway/dto/ipag-pagamentos.dto';
import { IPagService } from 'src/payment-gateway/ipag.service';
@Injectable()
export class WhatsAppService {
    private readonly whatsappConfig: WhatsAppConfig;
    private readonly phoneNumberId: string;
    private readonly accessToken: string;
    private readonly graphApiUrl: string;
    private readonly logger = new Logger(WhatsAppService.name);
    constructor(
        private readonly configService: ConfigService,
        @Inject(forwardRef(() => MessageService)) private readonly messageService: MessageService,
        private readonly httpService: HttpService,
        private readonly whatsappApi: WhatsAppApiService,
        private readonly ipagService: IPagService
    ) {
        this.whatsappConfig = {
            verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
        };
        const env = process.env.ENVIRONMENT;
        this.phoneNumberId = env === "demo" ? process.env.WHATSAPP_DEMO_PHONE_NUMBER_ID : (env === "homologation" || env === "development" ? process.env.WHATSAPP_TEST_PHONE_NUMBER_ID : process.env.WHATSAPP_PROD_PHONE_NUMBER_ID);
        this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        this.graphApiUrl = `https://graph.facebook.com/v22.0`;
    }

    handleWebhookVerification(query: WebhookVerificationDto): string {
        if (
            query.mode === 'subscribe' &&
            query.verifyToken === this.whatsappConfig.verifyToken
        ) {
            // this.logger.log('Webhook verified');
            return query.challenge;
        } else {
            throw new Error('Webhook verification failed');
        }
    }

    async processWebhookNotification(notification: WebhookNotificationDto | WebhookFlowNotificationDto): Promise<void> {
        // this.logger.log(`[processWebhookNotification] Notification type: ${notification.object}`);

        // Check if the message is from the correct phone number ID for the current environment
        const currentEnv = process.env.ENVIRONMENT;
        const messagePhoneNumberId = notification.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

        // Skip processing if the message is not from the phone number ID for the current environment
        if (messagePhoneNumberId) {
            const envPhoneNumberId = currentEnv === "demo"
                ? process.env.WHATSAPP_DEMO_PHONE_NUMBER_ID
                : (currentEnv === "homologation" || currentEnv === "development"
                    ? process.env.WHATSAPP_TEST_PHONE_NUMBER_ID
                    : process.env.WHATSAPP_PROD_PHONE_NUMBER_ID);

            if (messagePhoneNumberId !== envPhoneNumberId) {
                this.logger.log(`Skipping message from phone_number_id ${messagePhoneNumberId} as it doesn't match current environment (${currentEnv}) phone number ID ${envPhoneNumberId}`);
                return;
            }
        }

        try {
            // Check if this is a payment flow notification
            if (notification.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.interactive?.type === 'nfm_reply') {
                const message = notification.entry[0].changes[0].value.messages[0];
                if (message?.interactive?.nfm_reply?.response_json) {
                    const paymentData = JSON.parse(message.interactive.nfm_reply.response_json);

                    if (paymentData.paymentMethod === 'credit-card') {
                        const [expiryMonth, expiryYear] = paymentData.expiration_date.split('/');

                        const userPaymentInfo: UserPaymentCreditInfoDto = {
                            transactionId: paymentData.transaction_id,
                            saveCard: paymentData.save_card?.includes('save_card_option') || false,
                            cardInfo: {
                                holder: paymentData.holder_name,
                                number: paymentData.card_number,
                                expiry_month: expiryMonth,
                                expiry_year: `20${expiryYear}`,
                                cvv: paymentData.cvv,
                                tokenize: paymentData.save_card?.includes('save_card_option') || false
                            },
                            customerInfo: {
                                name: paymentData.holder_name,
                                cpf_cnpj: paymentData.holder_cpf.replace(/[^\d]/g, '')
                            }
                        };

                        this.logger.log(`Processing credit card payment for transaction: ${userPaymentInfo.transactionId}`);
                        await this.ipagService.createCreditCardPayment(userPaymentInfo);
                        return;
                    }
                }
            }
        } catch (error) {
            // this.logger.error(`Error processing payment flow: ${error.message}`);
            // throw new HttpException('Failed to process payment information', HttpStatus.BAD_REQUEST);
        }

        if (notification.entry) {
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
    }

    private async handleMessageNotification(value: any): Promise<void> {
        const { messages = [] } = value;
        for (const message of messages) {
            try {
                if (message.id) {
                    await this.whatsappApi.markMessageAsSeen(message.id);
                }
            } catch (error) {
                // this.logger.error(`Error marking message as seen: ${error}`);
            }

            // Extract the timestamp
            const timestamp = message.timestamp;
            // this.logger.log(`Received message with timestamp: ${timestamp}`);

            // Parse the message
            const requestStructure: RequestStructure = this.parseMessage(message);

            // Attach the timestamp to the request structure if needed
            requestStructure.timestamp = timestamp;

            const messageId = message.id;

            // Example: Reacting to a specific text message
            if (message.type === 'text' &&
                message.text?.body?.toLowerCase().includes('pagar a comanda')) {
                try {
                    await this.whatsappApi.sendMessageReaction(
                        requestStructure.from,
                        messageId,
                        "😍"
                    );
                } catch (error) {
                    // this.logger.error(`Error sending reaction: ${error}`);
                }
            }

            // Process the message
            const result = await this.messageService.handleProcessMessage(requestStructure);
            await this.whatsappApi.sendWhatsAppMessages(result);
        }
    }

    private async handleStatusNotification(value: any): Promise<void> {
        // this.logger.log(`Processing status notification: ${value}`);
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
            case 'interactive':
                parsedType = 'text';
                if (message.interactive?.type === 'button_reply') {
                    const buttonReply = message.interactive.button_reply;
                    // this.logger.log(`Received button interaction - ID: ${buttonReply.id}, Title: ${buttonReply.title}`);
                    // Format as text message with the button ID as prefix for easy processing
                    content = `button_${buttonReply.id}:${buttonReply.title}`;
                } else {
                    content = 'Interação de botão desconhecida';
                }
                break;
            default:
                parsedType = 'text';
                content = 'Mensagem de tipo desconhecido';
        }

        return {
            from,
            type: parsedType,
            content,
            timestamp: message.timestamp
        };
    }

    

}