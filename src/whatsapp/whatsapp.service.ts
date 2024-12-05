// src/whatsapp/whatsapp.service.ts

import { Injectable, OnModuleInit, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import { TableService } from 'src/table/table.service';
import { LangchainService } from 'src/langchain/langchain.service';
import {
    ConversationStep,
    PaymentStatus,
    ConversationDto,
    CreateConversationDto,
    UpdateConversationDto,
    FeedbackDTO,
    MessageDTO,
    MessageType
} from '../conversation/dto/conversation.dto';
import { formatToBRL } from './utils/currency.utils';
import { ConversationService } from 'src/conversation/conversation.service';
import { CreateUserDto } from 'src/user/dto/user.dto';
import { UserService } from 'src/user/user.service';
import {
    handleAwaitingUserDecision,
    handleConfirmOrder,
    handleExtraTip,
    handleFeedback,
    handleFeedbackDetail,
    handleOrderProcessing,
    handleOverpaymentDecision,
    handlePaymentReminder,
    handleSplitBill,
    handleSplitBillNumber,
    handleWaitingForContacts,
    handleWaitingForPayment
} from './utils/customer.message.factory';

/**
 * The WhatsAppService class integrates with the WhatsApp Web API to manage conversations.
 * It handles incoming messages from authorized users, updates conversation states,
 * and delegates message handling to factory functions for different conversation steps.
 */
@Injectable()
export class WhatsAppService implements OnModuleInit, OnApplicationShutdown {
    private client: Client;
    private readonly logger = new Logger(WhatsAppService.name);
    private clientStates: Map<string, ConversationDto> = new Map();
    private debugMode = process.env.DEBUG === 'true';

    constructor(
        private readonly tableService: TableService,
        private readonly langchainService: LangchainService,
        private readonly userService: UserService,
        private readonly conversationService: ConversationService,
    ) {
        this.client = new Client({
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            },
            authStrategy: new LocalAuth({
                clientId: 'coti-payments',
            }),
        });
    }

    /**
     * Lifecycle hook called when the module is initialized.
     * Initializes the WhatsApp client unless in debug mode.
     */
    async onModuleInit() {
        console.log('Initializing WhatsApp Client...');
        this.initializeClient();
    }

    /**
     * Lifecycle hook called when the module is destroyed.
     * Ensures the WhatsApp client is properly closed.
     */
    async onApplicationShutdown(signal?: string) {
        console.log('Shutting down WhatsApp Client...', signal);
        if (this.client) {
            try {
                await this.client.destroy();
                this.logger.log('WhatsApp Client and Puppeteer closed successfully.');
            } catch (error) {
                this.logger.error('Error closing WhatsApp Client:', error);
            }
        }
    }    

    /**
     * Initializes the WhatsApp client, setting up event listeners for QR code, readiness, and incoming messages.
     */
    private initializeClient() {
        if (this.debugMode) {
            this.logger.log('DEBUG mode is ON. WhatsApp client will not be initialized.');
            return; // Skip initializing the WhatsApp client in debug mode
        }

        this.client.on('qr', (qr) => {
            this.logger.log('QR RECEIVED, scan please');
            qrcode.generate(qr, { small: true });
        });

        this.client.on('ready', () => {
            this.logger.log('WhatsApp Client is ready!');
        });

        this.client.on('message_create', async (message: Message) => {
            // Ignore messages sent by the bot itself
            if (message.fromMe) {
                return;
            }

            // Ignore messages from groups
            if (message.from.includes('@g.us')) {
                this.logger.debug(`Ignoring message from group: ${message.from}`);
                return;
            }

            // Only respond if the number is in the allowed list
            const allowedNumbers = [
                '551132803247@c.us',
                '5511947246803@c.us',
            ];
            if (!allowedNumbers.includes(message.from)) {
                this.logger.debug(`Ignoring message from ${message.from}: ${message.body}`);
                return;
            }

            // Calculate message age to avoid processing old messages
            const currentTime = Math.floor(Date.now() / 1000); // current time in seconds
            const messageAge = currentTime - message.timestamp; // message timestamp is in seconds
            const maxAllowedAge = 30; // 30 seconds

            if (messageAge > maxAllowedAge) {
                this.logger.debug(`Ignoring old message from ${message.from}: ${message.body}`);
                return; // Ignore old messages
            }

            const contact = await message.getContact();
            const from = contact.id._serialized;

            // Handle incoming message and manage conversation state
            await this.handleIncomingMessage(from, message);

            // Retrieve the user
            let user = await this.userService.getUser(from).catch(() => null);
            if (!user) {
                this.logger.error(`User ${from} not found after handleIncomingMessage`);
                return;
            }

            // Retrieve the active conversation
            const activeConversationResponse = await this.conversationService.getActiveConversation(from);
            const state = activeConversationResponse.data;

            if (!state) {
                this.logger.debug(`No active conversation for user ${from}`);
                // Prompt the user to start a new conversation
                await message.reply(
                    'Desculpe, não entendi sua solicitação. Se você gostaria de pagar uma comanda, por favor, use a frase "Gostaria de pagar a comanda X".',
                );
                return;
            }

            const userMessage = message.body.trim().toLowerCase();

            // Log current state for debugging
            this.logger.debug(
                `User: ${from}, State: ${state.conversationContext.currentStep}, Message: "${userMessage}"`,
            );

            // Handle conversation steps
            switch (state.conversationContext.currentStep) {
                case ConversationStep.ProcessingOrder:
                    // No action needed in this case
                    break;

                case ConversationStep.ConfirmOrder:
                    await handleConfirmOrder(from, userMessage, state);
                    break;

                case ConversationStep.SplitBill:
                    await handleSplitBill(from, userMessage, state);
                    break;

                case ConversationStep.SplitBillNumber:
                    await handleSplitBillNumber(from, userMessage, state);
                    break;

                case ConversationStep.WaitingForContacts:
                    await handleWaitingForContacts(from, state, message);
                    break;

                case ConversationStep.ExtraTip:
                    await handleExtraTip(from, userMessage, state);
                    break;

                case ConversationStep.WaitingForPayment:
                    await handleWaitingForPayment(from, userMessage, state, message);
                    break;

                case ConversationStep.AwaitingUserDecision:
                    await handleAwaitingUserDecision(from, userMessage, state);
                    break;

                case ConversationStep.OverpaymentDecision:
                    await handleOverpaymentDecision(from, userMessage, state);
                    break;

                case ConversationStep.PaymentReminder:
                    await handlePaymentReminder(from, userMessage, state);
                    break;

                case ConversationStep.Feedback:
                    await handleFeedback(from, userMessage, state);
                    break;

                case ConversationStep.FeedbackDetail:
                    await handleFeedbackDetail(from, userMessage, state);
                    break;

                case ConversationStep.Completed:
                    // Conversation completed; no action needed
                    break;

                default:
                    if (userMessage.includes('pagar a comanda')) {
                        await handleOrderProcessing(from, userMessage, state, message);
                    } else {
                        await message.reply(
                            'Desculpe, não entendi sua solicitação. Se você gostaria de pagar uma comanda, por favor, use a frase "Gostaria de pagar a comanda X".',
                        );
                    }
                    break;
            }
        });

        this.client.initialize();
    }

    /**
     * Handles the incoming message, ensuring the user and conversation are registered in the database,
     * and adds the message to the conversation history.
     *
     * @param userId - The unique identifier of the user sending the message.
     * @param message - The received message object.
     */
    private async handleIncomingMessage(userId: string, message: Message): Promise<void> {
        const messageDTO: MessageDTO = {
            messageId: message.id._serialized,
            content: message.body,
            type: MessageType.User,
            timestamp: new Date(),
            senderId: userId,
        };

        let user = await this.userService.getUser(userId).catch(() => null);
        if (!user) {
            const newUser: CreateUserDto = {
                userId,
                country: "BR",
                name: null,
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            user = await this.userService.createUser(newUser);
        }

        const activeConversationResponse = await this.conversationService
            .getActiveConversation(userId)
            .catch(() => null);

        if (!activeConversationResponse?.data) {
            const newConversation: CreateConversationDto = {
                userId,
                conversationContext: {
                    currentStep: ConversationStep.Initial,
                    messages: [messageDTO],
                    lastMessage: new Date(),
                },
            };
            const createdConversation = await this.conversationService.createConversation(newConversation);
            console.log("New conversation started:", createdConversation);
        } else {
            const conversationId = activeConversationResponse.data._id;
            await this.conversationService.addMessage(conversationId, messageDTO);
            console.log("Message added to active conversation:", conversationId);
        }
    }
}
