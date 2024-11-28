// src/whatsapp/whatsapp.service.ts

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import { TableService } from 'src/table/table.service';
import { LangchainService } from 'src/langchain/langchain.service';
import { ConversationStep, PaymentStatus, ConversationContextDTO, PaymentDetailsDTO, SplitInfoDTO, FeedbackDTO, PaymentProofDTO, MessageDTO, MessageType, UpdateConversationDto, ConversationDto, CreateConversationDto } from '../conversation/dto/conversation.dto';
import { formatToBRL } from './utils/currency.utils';
import { ConversationService } from 'src/conversation/conversation.service';
import { CreateUserDto } from 'src/user/dto/user.dto';
import { UserService } from 'src/user/user.service';

@Injectable()
export class WhatsAppService implements OnModuleInit {
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

    async onModuleInit() {
        console.log('Initializing WhatsApp Client...');
        this.initializeClient();
    }

    async onModuleDestroy() {
        console.log('Shutting down WhatsApp Client...');
        if (this.client) {
            try {
                await this.client.destroy();
                this.logger.log('WhatsApp Client and Puppeteer closed successfully.');
            } catch (error) {
                this.logger.error('Error closing WhatsApp Client:', error);
            }
        }
    }

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

            // Check if the message is from a group (group chats have IDs ending with '@g.us')
            if (message.from.includes('@g.us')) {
                this.logger.debug(`Ignoring message from group: ${message.from}`);
                return; // Ignore messages from groups
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
            const currentTime = Math.floor(Date.now() / 1000); // Get current time in seconds
            const messageAge = currentTime - message.timestamp; // Message timestamp is in seconds
            const maxAllowedAge = 30; // 30 seconds

            if (messageAge > maxAllowedAge) {
                this.logger.debug(`Ignoring old message from ${message.from}: ${message.body}`);
                return; // Ignore message if it's older than 30 seconds
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

            switch (state.conversationContext.currentStep) {
                case ConversationStep.ProcessingOrder:
                    // No action needed in this case
                    break;

                case ConversationStep.ConfirmOrder:
                    await this.handleConfirmOrder(from, userMessage, state);
                    break;

                case ConversationStep.SplitBill:
                    await this.handleSplitBill(from, userMessage, state);
                    break;

                case ConversationStep.SplitBillNumber:
                    await this.handleSplitBillNumber(from, userMessage, state);
                    break;

                case ConversationStep.WaitingForContacts:
                    await this.handleWaitingForContacts(from, state, message);
                    break;

                case ConversationStep.ExtraTip:
                    await this.handleExtraTip(from, userMessage, state);
                    break;

                case ConversationStep.WaitingForPayment:
                    await this.handleWaitingForPayment(from, userMessage, state, message);
                    break;

                case ConversationStep.AwaitingUserDecision:
                    await this.handleAwaitingUserDecision(from, userMessage, state);
                    break;

                case ConversationStep.OverpaymentDecision:
                    await this.handleOverpaymentDecision(from, userMessage, state);
                    break;

                case ConversationStep.PaymentReminder:
                    await this.handlePaymentReminder(from, userMessage, state);
                    break;

                case ConversationStep.Feedback:
                    await this.handleFeedback(from, userMessage, state);
                    break;

                case ConversationStep.FeedbackDetail:
                    await this.handleFeedbackDetail(from, userMessage, state);
                    break;

                case ConversationStep.Completed:
                    // Conversation completed; no action needed
                    break;

                default:
                    if (userMessage.includes('pagar a comanda')) {
                        await this.handleOrderProcessing(from, userMessage, state, message);
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

    private async handleIncomingMessage(userId: string, message: Message): Promise<void> {

        const messageDTO: MessageDTO = {
            messageId: message.id._serialized,
            content: message.body,
            type: MessageType.User, // Corrected to MessageType.User
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


    private extractOrderId(message: string): string | null {
        const match = message.match(/\bcomanda\s*(\d+)/i);
        return match ? match[1] : null;
    }

    private calculateUserAmount(state: ConversationDto): number {
        const totalAmount = state.orderDetails.totalAmount;

        if (!state.conversationContext.splitInfo) {
            state.conversationContext.splitInfo = { numberOfPeople: 1, contacts: [] };
        }

        const numPeople = state.conversationContext.splitInfo.numberOfPeople || 1;
        return parseFloat((totalAmount / numPeople).toFixed(2));
    }


    // Helper function to send messages with a delay between each
    private async sendMessageWithDelay(
        from: string,
        messages: string[],
        state: ConversationDto,
        delay: number = 2000,
    ): Promise<string[]> {
        const sentMessages = [];
        const messageLogs: MessageDTO[] = []; // Lista para registrar mensagens no banco

        for (const msg of messages) {
            if (!this.debugMode) {
                await this.client.sendMessage(from, msg);
            } else {
                this.logger.debug(`DEBUG mode ON: Simulating sending message to ${from}: ${msg}`);
            }

            sentMessages.push(msg); // Registra a mensagem enviada

            // Adiciona a mensagem ao log
            messageLogs.push({
                messageId: `msg-${Date.now()}`, // Gerar um ID fictício
                content: msg,
                type: MessageType.Bot,
                timestamp: new Date(),
                senderId: from,
            });

            await new Promise((resolve) => setTimeout(resolve, delay));
        }

        // Salva as mensagens no banco
        if (messageLogs.length > 0) {
            await this.conversationService.addMessages(state._id.toString(), messageLogs);
        }

        return sentMessages; // Retorna as mensagens enviadas
    }


    private async isOrderBeingProcessed(
        order_id: string,
        from: string,
    ): Promise<{ isProcessing: boolean; state?: ConversationDto; userNumber?: string }> {
        // Busca todas as conversas ativas relacionadas ao order_id, exceto a do usuário atual
        const activeConversationsResponse = await this.conversationService.getActiveConversationsByOrderId(parseInt(order_id));
        const activeConversations = activeConversationsResponse.data;

        for (const conversation of activeConversations) {
            const conversationContext = conversation.conversationContext;
            if (!conversationContext || !conversationContext.currentStep) {
                continue;
            }

            const currentStep = conversationContext.currentStep;

            if (
                conversationContext.paymentDetails?.orderId === parseInt(order_id) &&
                conversation.userId !== from &&
                ![ConversationStep.Completed, ConversationStep.IncompleteOrder].includes(currentStep)
            ) {
                const userNumber = conversation.userId.split('@')[0];
                return { isProcessing: true, state: conversation, userNumber };
            }
        }

        return { isProcessing: false };
    }


    private async retryRequestWithNotification(
        from: string,
        requestFunction: () => Promise<any>,
        state: ConversationDto,
    ): Promise<any> {
        const maxRetries = 5;
        const delayBetweenRetries = 30000; // 30 seconds
        let attempts = 0;

        while (attempts < maxRetries) {
            try {
                return await requestFunction();
            } catch (error) {
                attempts++;
                this.logger.error(
                    `Attempt ${attempts} failed for user ${from} at stage ${state.conversationContext.currentStep}. Error: ${error}`
                );

                if (attempts === 3) {
                    const delayMessage = this.getDelayMessage(state.conversationContext.currentStep);
                    await this.sendMessageWithDelay(from, [delayMessage], state);
                }

                if (attempts < maxRetries) {
                    await new Promise((resolve) => setTimeout(resolve, delayBetweenRetries));
                }

                this.sendAuthenticationStatusToGroup(`Coti Pagamentos - Erro ao conectar com o PDV \n\n Por favor *gere* uma nova *credencial* para a automação.`);
            }
        }

        const errorMessage = this.generateStageErrorMessage(state.conversationContext.currentStep);
        await this.sendMessageWithDelay(from, [errorMessage], state);

        throw new Error("Max retries reached");
    }

    private getDelayMessage(
        currentStep: ConversationStep,
    ): string {
        switch (currentStep) {
            case ConversationStep.ProcessingOrder:
                return `🔄 O processamento da sua comanda está demorando um pouco mais que o esperado.\n\n Por favor, aguarde um instante enquanto verificamos os detalhes para você! 😊`;

            case ConversationStep.ConfirmOrder:
                return `🔄 Estamos confirmando os detalhes da sua comanda, mas parece que está demorando um pouco mais do que o habitual.\n\n Por favor, mantenha-se à vontade, logo finalizaremos! 😄`;

            case ConversationStep.SplitBill:
                return `🔄 O processo de divisão da conta está em andamento, mas pode levar alguns instantes a mais.\n\n Agradecemos pela paciência! 🎉`;

            case ConversationStep.WaitingForContacts:
                return `🔄 Estamos aguardando os contatos para dividir a conta.\n\n Isso pode demorar um pouco mais do que o esperado. Obrigado pela compreensão! 📲`;

            case ConversationStep.WaitingForPayment:
                return `🔄 Estamos aguardando a confirmação do pagamento. Pode levar alguns instantes.\n\n Agradecemos pela paciência! 🕒`;

            default:
                return `🔄 O processo está demorando um pouco mais do que o esperado.\n\n Por favor, mantenha-se à vontade, logo concluiremos! 😄`;
        }
    }

    private generateStageErrorMessage(currentStep: ConversationStep): string {
        switch (currentStep) {
            case ConversationStep.ProcessingOrder:
                return `Um erro ocorreu ao processar sua comanda.\n\n👨‍💼 Um de nossos atendentes está a caminho para te ajudar!`;

            case ConversationStep.ConfirmOrder:
                return `Um erro ocorreu ao confirmar os detalhes da sua comanda.\n\n👨‍💼 Um de nossos atendentes está a caminho para te ajudar!`;

            case ConversationStep.SplitBill:
                return `Um erro ocorreu ao dividir a conta.\n\n👨‍💼 Um de nossos atendentes está a caminho para te ajudar!`;

            case ConversationStep.WaitingForContacts:
                return `Um erro ocorreu ao processar os contatos para divisão de conta.\n\n👨‍💼 Um de nossos atendentes está a caminho para te ajudar!`;

            case ConversationStep.WaitingForPayment:
                return `Um erro ocorreu ao verificar o pagamento.\n\n👨‍💼 Um de nossos atendentes está a caminho para te ajudar!`;

            default:
                return `Um erro ocorreu durante o processamento.\n\n👨‍💼 Um de nossos atendentes está a caminho para te ajudar!`;
        }
    }

    private async sendProofToGroup(proofMessage: Message): Promise<void> {
        // Nome do grupo
        const groupName = 'Coti + Cris Parrilla [COMPROVANTES]';

        try {
            // Localiza o chat do grupo pelo nome
            const chats = await this.client.getChats();
            const groupChat = chats.find(chat => chat.isGroup && chat.name === groupName);

            if (groupChat) {
                // Encaminha a mensagem para o grupo
                await proofMessage.forward(groupChat.id._serialized);
                this.logger.log(`Mensagem de comprovante encaminhada para o grupo: ${groupName}`);
            } else {
                this.logger.warn(`Grupo "${groupName}" não encontrado.`);
            }
        } catch (error) {
            this.logger.error(`Erro ao encaminhar mensagem para o grupo ${groupName}: ${error}`);
        }
    }

    private async sendAuthenticationStatusToGroup(message: string): Promise<void> {
        const groupName = 'Grupo Teste';

        try {
            const chats = await this.client.getChats();
            const groupChat = chats.find(chat => chat.isGroup && chat.name === groupName);

            if (groupChat) {
                await this.client.sendMessage(groupChat.id._serialized, message);
                this.logger.log(`Mensagem de status de autenticação enviada para o grupo: ${groupName}`);
            } else {
                this.logger.warn(`Grupo "${groupName}" não encontrado.`);
            }
        } catch (error) {
            this.logger.error(`Erro ao encaminhar mensagem para o grupo ${groupName}: ${error}`);
        }
    }

    private async sendPaymentConfirmationToAttendants(state: ConversationDto): Promise<void> {
        // Nome do grupo
        const groupName = 'Grupo Teste';

        try {
            // Localiza o chat do grupo pelo nome
            const chats = await this.client.getChats();
            const groupChat = chats.find(chat => chat.isGroup && chat.name === groupName);

            if (groupChat) {
                let message = '';

                // Obter o ID do pedido e valor total
                const orderId = state.conversationContext.paymentDetails.orderId;
                const totalAmount = state.orderDetails.totalAmount;

                // Verificar se a conta está sendo dividida
                if (state.conversationContext.splitInfo && state.conversationContext.splitInfo.numberOfPeople > 1) {
                    const splitInfo = state.conversationContext.splitInfo;
                    const numberOfPeople = splitInfo.numberOfPeople;
                    const contacts = splitInfo.contacts;

                    message += `🧾 *Comanda ${orderId}* está sendo paga de forma compartilhada.\n`;
                    message += `Total a ser pago: ${formatToBRL(totalAmount)}\n\n`;
                    message += `👥 *Divisão entre ${numberOfPeople} pessoas:*\n`;

                    // Inclui o status do pagamento do cliente que iniciou o processo
                    const currentUserName = 'Cliente'; // Se possível, obtenha o nome real do usuário
                    const userAmount = state.conversationContext.userAmount;

                    let totalPaidByUser = 0;
                    if (state.conversationContext.paymentProofs && state.conversationContext.paymentProofs.length > 0) {
                        totalPaidByUser = state.conversationContext.paymentProofs.reduce((sum, proof) => sum + proof.valor, 0);
                    }
                    const remainingAmount = userAmount - totalPaidByUser;

                    if (remainingAmount > 0) {
                        // Usuário pagou menos do que deveria
                        message += `• ${currentUserName} - deveria pagar: ${formatToBRL(userAmount)}, pagou: ${formatToBRL(totalPaidByUser)}, restante: ${formatToBRL(remainingAmount)} - Pendente\n`;
                    } else if (remainingAmount < 0) {
                        // Usuário pagou mais do que deveria
                        message += `• ${currentUserName} - deveria pagar: ${formatToBRL(userAmount)}, pagou: ${formatToBRL(totalPaidByUser)}, excedente: ${formatToBRL(-remainingAmount)} - Pago\n`;
                    } else {
                        // Pagamento completo
                        message += `• ${currentUserName} - pagou: ${formatToBRL(totalPaidByUser)} - Pago\n`;
                    }

                    // Inclui o status de pagamento de cada contato na divisão
                    for (const contact of contacts) {
                        const name = contact.name || 'Cliente';
                        const contactId = `${contact.phone}@c.us`;
                        const contactState = this.clientStates.get(contactId);

                        let contactUserAmount = contact.individualAmount;
                        let totalPaidByContact = 0;
                        let contactRemainingAmount = contactUserAmount;

                        if (contactState) {
                            contactUserAmount = contactState.conversationContext.userAmount;

                            if (contactState.conversationContext.paymentProofs && contactState.conversationContext.paymentProofs.length > 0) {
                                totalPaidByContact = contactState.conversationContext.paymentProofs.reduce((sum, proof) => sum + proof.valor, 0);
                            }

                            contactRemainingAmount = contactUserAmount - totalPaidByContact;

                            if (contactRemainingAmount > 0) {
                                // Contato pagou menos do que deveria
                                message += `• ${name} - deveria pagar: ${formatToBRL(contactUserAmount)}, pagou: ${formatToBRL(totalPaidByContact)}, restante: ${formatToBRL(contactRemainingAmount)} - Pendente\n`;
                            } else if (contactRemainingAmount < 0) {
                                // Contato pagou mais do que deveria
                                message += `• ${name} - deveria pagar: ${formatToBRL(contactUserAmount)}, pagou: ${formatToBRL(totalPaidByContact)}, excedente: ${formatToBRL(-contactRemainingAmount)} - Pago\n`;
                            } else {
                                // Pagamento completo
                                message += `• ${name} - pagou: ${formatToBRL(totalPaidByContact)} - Pago\n`;
                            }
                        } else {
                            // Contato ainda não iniciou o processo de pagamento
                            message += `• ${name} - deveria pagar: ${formatToBRL(contactUserAmount)} - Pendente\n`;
                        }
                    }

                } else {
                    // Pagamento único (não dividido)
                    const currentUserName = 'Cliente'; // Se possível, obtenha o nome real do usuário
                    const userAmount = state.conversationContext.userAmount;

                    let totalPaidByUser = 0;
                    if (state.conversationContext.paymentProofs && state.conversationContext.paymentProofs.length > 0) {
                        totalPaidByUser = state.conversationContext.paymentProofs.reduce((sum, proof) => sum + proof.valor, 0);
                    }
                    const remainingAmount = userAmount - totalPaidByUser;

                    if (remainingAmount > 0) {
                        // Usuário pagou menos do que deveria
                        message += `⚠️ *Comanda ${orderId} paga parcialmente*\n`;
                        message += `• ${currentUserName} deveria pagar: ${formatToBRL(userAmount)}\n`;
                        message += `• Pagou: ${formatToBRL(totalPaidByUser)}\n`;
                        message += `• Restante a pagar: ${formatToBRL(remainingAmount)}\n\n`;
                    } else if (remainingAmount < 0) {
                        // Usuário pagou mais do que deveria
                        message += `⚠️ *Comanda ${orderId} paga com valor excedente*\n`;
                        message += `• ${currentUserName} deveria pagar: ${formatToBRL(userAmount)}\n`;
                        message += `• Pagou: ${formatToBRL(totalPaidByUser)}\n`;
                        message += `• Excedente: ${formatToBRL(-remainingAmount)}\n\n`;
                    } else {
                        // Pagamento completo
                        message += `✅ *Comanda ${orderId} paga em totalidade*\n`;
                        message += `• ${currentUserName} pagou: ${formatToBRL(totalPaidByUser)}\n\n`;
                    }

                    message += `🔹 *Total da Comanda:* ${formatToBRL(totalAmount)}`;
                }

                // Envia a mensagem para o grupo
                await this.client.sendMessage(groupChat.id._serialized, message);
                this.logger.log(`Mensagem de confirmação de pagamento enviada para o grupo: ${groupName}`);
            } else {
                this.logger.warn(`Grupo "${groupName}" não encontrado.`);
            }
        } catch (error) {
            this.logger.error(`Erro ao enviar mensagem para o grupo ${groupName}: ${error}`);
        }
    }

    // 0. Order Processing
    private async handleOrderProcessing(
        from: string,
        userMessage: string,
        state: ConversationDto,
        message: Message,
    ): Promise<void> {
        const order_id = this.extractOrderId(userMessage);

        if (!order_id) {
            await message.reply(
                'Desculpe, não entendi o número da comanda. Por favor, diga "Gostaria de pagar a comanda X", onde X é o número da comanda.',
            );
            return;
        }

        const orderProcessingInfo = await this.isOrderBeingProcessed(order_id, from);

        if (orderProcessingInfo.isProcessing) {
            const otherState = orderProcessingInfo.state;
            const userNumber = orderProcessingInfo.userNumber;

            const lastMessageTime = otherState?.conversationContext?.lastMessage
                ? new Date(otherState.conversationContext.lastMessage).getTime()
                : 0;
            const currentTimeMs = Date.now();
            const timeSinceLastMessage = (currentTimeMs - lastMessageTime) / (1000 * 60); // in minutes
            const inactivityThreshold = 5; // 5 minutes

            if (timeSinceLastMessage > inactivityThreshold) {
                this.logger.log(
                    `Previous user ${userNumber} inactive for ${timeSinceLastMessage} minutes. Allowing new user to take over.`,
                );

                if (otherState?._id) {
                    await this.conversationService.updateConversationWithErrorStatus(
                        otherState._id.toString(),
                        ConversationStep.IncompleteOrder,
                    );
                } else {
                    this.logger.warn(
                        `Unable to mark conversation as errored for user ${userNumber}: Missing conversation ID.`,
                    );
                }

                const updatedContext = {
                    ...state.conversationContext,
                    currentStep: ConversationStep.ProcessingOrder,
                    paymentDetails: {
                        ...state.conversationContext.paymentDetails,
                        orderId: parseInt(order_id),
                    },
                };

                const updateConversationDto: UpdateConversationDto = {
                    userId: state.userId,
                    conversationContext: updatedContext,
                };

                await this.conversationService.updateConversation(state._id.toString(), updateConversationDto);

                await message.reply(
                    '👋 *Coti Pagamentos* - Que ótimo! Estamos processando sua comanda, por favor aguarde. 😁',
                );

                await this.handleProcessingOrder(from, state, parseInt(order_id));
            } else {
                const step = otherState?.conversationContext?.currentStep;
                if (
                    step &&
                    [
                        ConversationStep.SplitBill,
                        ConversationStep.SplitBillNumber,
                        ConversationStep.WaitingForContacts,
                    ].includes(step)
                ) {
                    await message.reply(
                        `Sua comanda está em processo de divisão de conta. O número *${userNumber}* está compartilhando os contatos para dividir a conta. Por favor, aguarde ou entre em contato com essa pessoa para participar da divisão.`,
                    );
                } else {
                    await message.reply(
                        'Desculpe, esta comanda já está sendo processada por outra pessoa.',
                    );
                }
                return;
            }
        } else {
            // Start processing the order for the current user
            const updatedContext = {
                ...state.conversationContext,
                currentStep: ConversationStep.ProcessingOrder,
                paymentDetails: {
                    ...state.conversationContext.paymentDetails,
                    orderId: parseInt(order_id),
                },
            };

            const updateConversationDto: UpdateConversationDto = {
                userId: state.userId,
                conversationContext: updatedContext,
            };

            await this.conversationService.updateConversation(state._id.toString(), updateConversationDto);

            await message.reply(
                '👋 *Coti Pagamentos* - Que ótimo! Estamos processando sua comanda, por favor aguarde. 😁',
            );

            await this.handleProcessingOrder(from, state, parseInt(order_id));
        }
    }





    // 1. Processing Order
    private async handleProcessingOrder(
        from: string,
        state: ConversationDto,
        order_id: number,
    ): Promise<string[]> {
        const conversationId = state._id.toString();
        try {
            const orderData = await this.retryRequestWithNotification(
                from,
                () => this.tableService.orderMessage(order_id),
                state,
            );
            const orderMessage = orderData.message;
            const orderDetails = orderData.details;

            const messages = [orderMessage, '👍 A sua comanda está correta?\n\n1- Sim\n2- Não'];
            const sentMessages = await this.sendMessageWithDelay(from, messages, state);
            const updateConversationDto: UpdateConversationDto = {
                userId: state.userId,
                conversationContext: {
                    ...state.conversationContext,
                    currentStep: ConversationStep.ConfirmOrder,
                },
                orderDetails: {
                    tableId: order_id,
                    items: orderDetails.orders,
                    totalAmount: orderDetails.total,
                    appliedDiscount: orderDetails.discount,
                },
            };
            await this.conversationService.updateConversation(conversationId, updateConversationDto);
            return sentMessages;
        } catch (error) {
            await this.conversationService.updateConversationWithErrorStatus(conversationId, ConversationStep.OrderNotFound);
        }
    }

    // 2. Confirm Order
    private async handleConfirmOrder(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<string[]> {
        const sentMessages = [];
        const positiveResponses = ['1', 'sim', 'correta', 'está correta', 'sim está correta'];
        const negativeResponses = ['2', 'não', 'nao', 'não está correta', 'incorreta', 'não correta'];

        let updatedContext = { ...state.conversationContext };

        if (positiveResponses.some((response) => userMessage.includes(response))) {
            const messages = [
                '👍 Você gostaria de dividir a conta?\n\n1- Sim, em partes iguais\n2- Não',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));
            updatedContext.currentStep = ConversationStep.SplitBill;
        } else if (negativeResponses.some((response) => userMessage.includes(response))) {
            const messages = [
                'Que pena! Lamentamos pelo ocorrido e o atendente responsável irá conversar com você.',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));
            updatedContext.currentStep = ConversationStep.IncompleteOrder;
        } else {
            const messages = ['Por favor, responda com 1 para Sim ou 2 para Não.'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));
        }

        // Update the conversation in the database
        const conversationId = state._id.toString();
        const updateConversationDto: UpdateConversationDto = {
            userId: state.userId,
            conversationContext: updatedContext,
        };
        await this.conversationService.updateConversation(conversationId, updateConversationDto);

        return sentMessages;
    }


    // 3. Split Bill
    private async handleSplitBill(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<string[]> {
        const sentMessages = [];
        const positiveResponses = [
            '1',
            'sim',
            'quero dividir',
            'dividir',
            'sim dividir',
            'partes iguais',
        ];
        const negativeResponses = ['2', 'não', 'nao', 'não quero dividir', 'não dividir'];

        if (positiveResponses.some((response) => userMessage.includes(response))) {
            const messages = [
                'Ok, gostaria de dividir entre quantas pessoas?\n\nLembrando que apenas suportamos a divisão em partes iguais.',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

            const updatedContext = {
                ...state.conversationContext,
                currentStep: ConversationStep.SplitBillNumber,
            };

            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        } else if (negativeResponses.some((response) => userMessage.includes(response))) {
            const messages = [
                'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

            const updatedContext = {
                ...state.conversationContext,
                currentStep: ConversationStep.ExtraTip,
                userAmount: this.calculateUserAmount(state),
            };

            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        } else {
            const messages = ['Por favor, responda com 1 para Sim ou 2 para Não.'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));
        }

        return sentMessages;
    }


    // 4. Split Bill Number
    private async handleSplitBillNumber(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<string[]> {
        const sentMessages = [];

        const numPeopleMatch = userMessage.match(/\d+/);
        const numPeople = numPeopleMatch ? parseInt(numPeopleMatch[0]) : NaN;

        if (!isNaN(numPeople) && numPeople > 1) {
            const updatedContext = {
                ...state.conversationContext,
                splitInfo: {
                    numberOfPeople: numPeople,
                    contacts: [],
                },
                currentStep: ConversationStep.WaitingForContacts,
            };

            const messages = [
                '😊 Perfeito! Agora, nos envie o contato das pessoas com quem deseja dividir a conta, ou peça para que elas escaneiem o QR Code da sua mesa. 📲',
                'Assim que recebermos todos os contatos, daremos continuidade ao atendimento e deixaremos tudo prontinho para vocês! 🎉',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        } else {
            const messages = ['Por favor, informe um número válido de pessoas (maior que 1).'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));
        }

        return sentMessages;
    }


    // 5. Waiting for Contacts
    private async handleWaitingForContacts(
        from: string,
        state: ConversationDto,
        message: Message,
    ): Promise<string[]> {
        const sentMessages = [];

        if (message.type === 'vcard' || message.type === 'multi_vcard') {
            try {
                const vcardDataArray = message.vCards;

                const contactsReceivedSoFar = state.conversationContext.splitInfo.contacts.length;
                const totalContactsExpected = state.conversationContext.splitInfo.numberOfPeople - 1;
                const remainingContactsNeeded = totalContactsExpected - contactsReceivedSoFar;

                if (remainingContactsNeeded <= 0) {
                    const messages = [
                        'Você já enviou todos os contatos necessários.',
                        'Vamos prosseguir com seu atendimento. 😄',
                    ];
                    sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

                    const updatedContext = {
                        ...state.conversationContext,
                        currentStep: ConversationStep.ExtraTip,
                    };
                    await this.conversationService.updateConversation(state._id.toString(), {
                        userId: state.userId,
                        conversationContext: updatedContext,
                    });

                    return sentMessages;
                }

                const vcardDataArrayLimited = vcardDataArray.slice(0, remainingContactsNeeded);

                let responseMessage = `✨ *Contato(s) Recebido(s) com Sucesso!* ✨\n`;

                const contactsToAdd = [];
                for (const vcardData of vcardDataArrayLimited) {
                    const vcardName = vcardData.split('FN:')[1]?.split('\n')[0] || 'Nome não informado';
                    let vcardPhone = vcardData.split('waid=')[1]?.split(':')[1]?.split('\n')[0] || '';
                    vcardPhone = vcardPhone.replace(/\D/g, '');

                    responseMessage += `\n👤 *Nome:* ${vcardName}\n📞 *Número:* ${vcardPhone}\n`;

                    contactsToAdd.push({
                        name: vcardName,
                        phone: vcardPhone,
                        individualAmount: 0,
                    });
                }

                state.conversationContext.splitInfo.contacts.push(...contactsToAdd);

                if (vcardDataArray.length > remainingContactsNeeded) {
                    responseMessage += `\n⚠️ Você enviou mais contatos do que o necessário.\nApenas o${remainingContactsNeeded > 1 ? 's primeiros' : ''} ${remainingContactsNeeded} contato${remainingContactsNeeded > 1 ? 's' : ''} foi${remainingContactsNeeded > 1 ? 'ram' : ''} considerado${remainingContactsNeeded > 1 ? 's' : ''}.`;
                }

                const totalContactsReceived = state.conversationContext.splitInfo.contacts.length;
                const remainingContacts = totalContactsExpected - totalContactsReceived;

                if (remainingContacts > 0) {
                    responseMessage += `\n🕒 Aguardando mais *${remainingContacts}* contato${remainingContacts > 1 ? 's' : ''} para continuar.`;
                } else {
                    if (vcardDataArray.length <= totalContactsExpected) {
                        responseMessage += `\n🎉 Todos os contatos foram recebidos! Vamos prosseguir com seu atendimento. 😄`;
                    }
                    state.conversationContext.currentStep = ConversationStep.ExtraTip;
                }

                sentMessages.push(...(await this.sendMessageWithDelay(from, [responseMessage], state)));

                if (remainingContacts <= 0) {
                    const totalAmount = state.orderDetails.totalAmount;
                    const numPeople = state.conversationContext.splitInfo.numberOfPeople;
                    const individualAmount = parseFloat((totalAmount / numPeople).toFixed(2));

                    const contacts = state.conversationContext.splitInfo.contacts.map((contact) => ({
                        ...contact,
                        individualAmount,
                    }));

                    const updatedContext = {
                        ...state.conversationContext,
                        splitInfo: {
                            ...state.conversationContext.splitInfo,
                            contacts,
                        },
                        paymentDetails: {
                            ...state.conversationContext.paymentDetails,
                            orderId: state.conversationContext.paymentDetails.orderId || state.orderDetails.tableId,
                            totalDue: individualAmount,
                            status: PaymentStatus.Pending,
                            initiatedAt: Date.now(),
                        },
                        currentStep: ConversationStep.ExtraTip,
                        userAmount: individualAmount,
                    };

                    await this.conversationService.updateConversation(state._id.toString(), {
                        userId: state.userId,
                        conversationContext: updatedContext,
                    });

                    for (const contact of contacts) {
                        const contactId = `${contact.phone}@c.us`;
                        const messages = [
                            `👋 Coti Pagamentos - Olá! Você foi incluído na divisão do pagamento da comanda *${state.conversationContext.paymentDetails.orderId}* no restaurante Cris Parrilla. Aguarde para receber mais informações sobre o pagamento.`,
                            `Sua parte na conta é de *${formatToBRL(individualAmount)}*.`,
                            'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
                        ];
                        await this.sendMessageWithDelay(contactId, messages, state);
                    }

                    const messages = [
                        'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
                    ];
                    sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));
                }
            } catch (error) {
                this.logger.error('Erro ao processar o(s) vCard(s):', error);
                const errorMessages = [
                    '❌ Ocorreu um erro ao processar o contato. Por favor, tente novamente enviando o contato.',
                ];
                sentMessages.push(...(await this.sendMessageWithDelay(from, errorMessages, state)));
            }
        } else {
            const promptMessages = [
                '📲 Por favor, envie o contato da pessoa com quem deseja dividir a conta.',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, promptMessages, state)));
        }

        return sentMessages;
    }



    // 6. Extra Tip
    private async handleExtraTip(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<string[]> {
        const sentMessages = [];
        const noTipKeywords = ['não', 'nao', 'n quero', 'não quero', 'nao quero'];
        const tipPercent = parseFloat(userMessage.replace('%', '').replace(',', '.'));

        const userAmount = state.conversationContext.userAmount;

        if (noTipKeywords.some((keyword) => userMessage.includes(keyword)) || tipPercent === 0) {
            const messages = [
                'Sem problemas!',
                `O valor final da sua conta é: *${formatToBRL(userAmount.toFixed(2))}*`,
                'Segue abaixo a chave PIX para pagamento 👇',
                '00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
                'Por favor, envie o comprovante! 📄✅',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

            const updatedContext = {
                ...state.conversationContext,
                currentStep: ConversationStep.WaitingForPayment,
                paymentStartTime: Date.now(),
            };

            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        } else if (tipPercent > 0) {
            let tipResponse = '';
            if (tipPercent <= 3) {
                tipResponse = `Obrigado! 😊 \nVocê escolheu ${tipPercent}%. Cada contribuição conta e sua ajuda é muito apreciada pela nossa equipe! 🙌`;
            } else if (tipPercent > 3 && tipPercent <= 5) {
                tipResponse = `Obrigado! 😊 \nVocê escolheu ${tipPercent}%, a mesma opção da maioria das últimas mesas. Sua contribuição faz a diferença para a equipe! 💪`;
            } else if (tipPercent > 5 && tipPercent <= 7) {
                tipResponse = `Incrível! 😄 \nVocê escolheu ${tipPercent}%, uma gorjeta generosa! Obrigado por apoiar nossa equipe de maneira tão especial. 💫`;
            } else {
                tipResponse = `Obrigado pela sua generosidade! 😊`;
            }
            sentMessages.push(tipResponse);

            const totalAmountWithTip = parseFloat(
                (this.calculateUserAmount(state) * (1 + tipPercent / 100)).toFixed(2),
            );

            const paymentMessages = [
                `O valor final da sua conta é: *${formatToBRL(totalAmountWithTip.toFixed(2))}*`,
                'Segue abaixo a chave PIX para pagamento 👇',
                '00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
                'Por favor, envie o comprovante! 📄✅',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, paymentMessages, state)));

            const updatedContext = {
                ...state.conversationContext,
                currentStep: ConversationStep.WaitingForPayment,
                paymentStartTime: Date.now(),
                userAmount: totalAmountWithTip,
            };

            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        } else {
            const messages = [
                'Por favor, escolha uma das opções de gorjeta: 3%, 5% ou 7%, ou diga que não deseja dar gorjeta.',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));
        }

        return sentMessages;
    }


    private async handleWaitingForPayment(
        from: string,
        userMessage: string,
        state: ConversationDto,
        message: Message,
    ): Promise<string[]> {
        const sentMessages: string[] = [];
        const currentTime = new Date();

        if (userMessage.includes('comprovante') || message.hasMedia) {
            try {
                if (message.hasMedia) {
                    const media = await message.downloadMedia();

                    if (media && media.data) {
                        const extractedText = await this.retryRequestWithNotification(
                            from,
                            () => this.langchainService.extractTextFromPDF(media.data),
                            state,
                        );

                        const analysisResult: PaymentProofDTO = await this.retryRequestWithNotification(
                            from,
                            () =>
                                this.langchainService.analyzeDocument(
                                    extractedText,
                                    state.conversationContext.userAmount,
                                ),
                            state,
                        );

                        if (!state.conversationContext.paymentProofs) {
                            state.conversationContext.paymentProofs = [];
                        }

                        const isDuplicate = state.conversationContext.paymentProofs.some(
                            (proof) => proof.id_transacao === analysisResult.id_transacao,
                        );

                        if (isDuplicate) {
                            const duplicateMessage = [
                                '❌ Este comprovante de pagamento já foi recebido anteriormente.\n\n Por favor, verifique seu comprovante.',
                            ];
                            sentMessages.push(
                                ...(await this.sendMessageWithDelay(from, duplicateMessage, state)),
                            );
                            return sentMessages;
                        }

                        state.conversationContext.paymentProofs.push(analysisResult);

                        const paymentDate = new Date(
                            analysisResult.data_pagamento.replace(' - ', 'T'),
                        );
                        const timeDifference =
                            (currentTime.getTime() - paymentDate.getTime()) / (1000 * 60);
                        const isRecentPayment = timeDifference <= 30; // Exemplo: Pagamento deve ter ocorrido nos últimos 30 minutos

                        // Validar beneficiário e CNPJ
                        const expectedBeneficiary = 'EMPORIO CRISTOVAO';
                        const expectedCNPJ = '42.081.641/0001-68';
                        const isBeneficiaryCorrect =
                            analysisResult.nome_beneficiario
                                ?.toUpperCase()
                                .includes(expectedBeneficiary) ||
                            analysisResult.cpf_cnpj_beneficiario === expectedCNPJ;

                        // Validar valor pago pelo usuário
                        const paymentValue = parseFloat(analysisResult.valor?.toString() || '0');
                        const isAmountCorrect = paymentValue === state.conversationContext.userAmount;
                        const isOverpayment = paymentValue > state.conversationContext.userAmount;

                        if (isRecentPayment && isBeneficiaryCorrect) {
                            if (isAmountCorrect) {
                                const messages = [
                                    'Pagamento confirmado.',
                                    'Muito obrigado por utilizar a *Coti* e realizar pagamentos mais *rápidos* 🙏',
                                    'Esperamos que sua experiência tenha sido excelente. Sua satisfação é muito importante para nós e estamos sempre prontos para te atender novamente! 😊',
                                    'Sua opinião é essencial para nós! Queremos saber:\n\nEm uma escala de 0 a 10, o quanto você recomendaria a Coti para amigos ou colegas?\n(0 = nada provável e 10 = muito provável)',
                                ];
                                sentMessages.push(
                                    ...(await this.sendMessageWithDelay(from, messages, state)),
                                );

                                const updatedContext = {
                                    ...state.conversationContext,
                                    currentStep: ConversationStep.Feedback,
                                };

                                await this.conversationService.updateConversation(
                                    state._id.toString(),
                                    { userId: state.userId, conversationContext: updatedContext },
                                );
                            } else if (isOverpayment) {
                                const excessAmount =
                                    paymentValue - state.conversationContext.userAmount;
                                const messages = [
                                    `❌ Você pagou um valor superior ao necessário: *${formatToBRL(
                                        paymentValue,
                                    )}* ao invés de *${formatToBRL(
                                        state.conversationContext.userAmount,
                                    )}*.`,
                                    `Você deseja:\n\n1- Adicionar o valor excedente de *${formatToBRL(
                                        excessAmount,
                                    )}* como gorjeta.\n2- Solicitar o estorno do valor extra.`,
                                ];
                                sentMessages.push(
                                    ...(await this.sendMessageWithDelay(from, messages, state)),
                                );

                                const updatedContext = {
                                    ...state.conversationContext,
                                    currentStep: ConversationStep.OverpaymentDecision,
                                    excessPaymentAmount: excessAmount,
                                };

                                await this.conversationService.updateConversation(
                                    state._id.toString(),
                                    { userId: state.userId, conversationContext: updatedContext },
                                );
                            } else {
                                const remainingAmount =
                                    state.conversationContext.userAmount - paymentValue;
                                const errorMessage = [
                                    `❌ O valor pago foi de ${formatToBRL(
                                        paymentValue,
                                    )} enquanto deveria ser ${formatToBRL(
                                        state.conversationContext.userAmount,
                                    )}.`,
                                    `💰 Você ainda tem um saldo de ${formatToBRL(
                                        remainingAmount,
                                    )} a pagar.\n\nEscolha uma das opções abaixo:\n1- Pagar valor restante.\n2- Chamar um atendente.`,
                                ];
                                sentMessages.push(
                                    ...(await this.sendMessageWithDelay(from, errorMessage, state)),
                                );

                                const updatedContext = {
                                    ...state.conversationContext,
                                    currentStep: ConversationStep.AwaitingUserDecision,
                                    userAmount: remainingAmount,
                                };

                                await this.conversationService.updateConversation(
                                    state._id.toString(),
                                    { userId: state.userId, conversationContext: updatedContext },
                                );
                            }
                        } else {
                            const errorMessage = [
                                '❌ O comprovante enviado apresenta inconsistências.\n👨‍💼 Um de nossos atendentes está a caminho para te ajudar!',
                            ];
                            sentMessages.push(
                                ...(await this.sendMessageWithDelay(from, errorMessage, state)),
                            );

                            const updatedContext = {
                                ...state.conversationContext,
                                currentStep: ConversationStep.PaymentInvalid,
                            };

                            await this.conversationService.updateConversation(
                                state._id.toString(),
                                { userId: state.userId, conversationContext: updatedContext },
                            );
                        }
                    }
                }
            } catch (error) {
                this.logger.error('Error processing payment proof:', error);
                const errorMessage = [
                    'Desculpe, não conseguimos processar o comprovante de pagamento. Por favor, envie novamente.',
                ];
                sentMessages.push(...(await this.sendMessageWithDelay(from, errorMessage, state)));
            }
        } else {
            const timeSincePaymentStart = Date.now() - state.conversationContext.paymentStartTime;
            if (timeSincePaymentStart > 5 * 60 * 1000) {
                const messages = [
                    'Notamos que ainda não recebemos seu comprovante. Se precisar de ajuda ou tiver algum problema, estamos aqui para ajudar! 👍',
                ];
                sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

                const updatedContext = {
                    ...state.conversationContext,
                    currentStep: ConversationStep.PaymentReminder,
                };

                await this.conversationService.updateConversation(state._id.toString(), {
                    userId: state.userId,
                    conversationContext: updatedContext,
                });
            }
        }

        return sentMessages;
    }



    private async handleOverpaymentDecision(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<string[]> {
        const sentMessages = [];
        const excessAmount = state.conversationContext.excessPaymentAmount;

        // Definindo respostas esperadas para as opções
        const addAsTipResponses = ['1', 'adicionar como gorjeta', 'gorjeta', 'adicionar gorjeta'];
        const refundResponses = ['2', 'estorno', 'solicitar estorno', 'extornar'];

        if (addAsTipResponses.some((response) => userMessage.includes(response))) {
            // Usuário escolheu adicionar como gorjeta
            const messages = [
                `🎉 Muito obrigado pela sua generosidade! O valor de *${formatToBRL(
                    excessAmount,
                )}* foi adicionado como gorjeta. 😊`,
                'Estamos felizes por você escolher a *Coti* para facilitar seus pagamentos e apoiar nossa equipe! 🙏',
                'Agora, queremos saber sua opinião! Em uma escala de 0 a 10, o quanto você recomendaria a Coti para amigos ou colegas?\n(0 = nada provável e 10 = muito provável)',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

            const updatedContext = {
                ...state.conversationContext,
                currentStep: ConversationStep.Feedback,
            };

            // Atualizar conversa no banco de dados
            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        } else if (refundResponses.some((response) => userMessage.includes(response))) {
            // Usuário escolheu solicitar o estorno
            const messages = [
                `Entendido! Vamos providenciar o estorno do valor excedente de *${formatToBRL(
                    excessAmount,
                )}* o mais rápido possível. 💸`,
                'Nosso time está aqui para garantir a melhor experiência para você. 😊',
                'Enquanto processamos o estorno, gostaríamos de saber sua opinião! Em uma escala de 0 a 10, o quanto você recomendaria a Coti para amigos ou colegas?\n(0 = nada provável e 10 = muito provável)',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

            const updatedContext = {
                ...state.conversationContext,
                currentStep: ConversationStep.Feedback,
            };

            // Atualizar conversa no banco de dados
            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        } else {
            // Caso o usuário insira uma resposta inválida
            const messages = [
                'Desculpe, não entendi sua resposta.',
                `Por favor, escolha uma das opções abaixo:\n1- Adicionar o valor excedente como gorjeta.\n2- Solicitar o estorno do valor extra.`,
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));
        }

        return sentMessages;
    }



    private async handleAwaitingUserDecision(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<string[]> {
        const sentMessages = [];
        const conversationId = state._id.toString();

        const positiveResponses = ['1', 'nova transação', 'realizar nova transação', 'pagar valor restante'];
        const assistanceResponses = ['2', 'chamar atendente', 'ajuda', 'preciso de ajuda'];

        if (positiveResponses.some((response) => userMessage.includes(response))) {
            // Atualizar o valor necessário para a nova transação
            const remainingAmount = state.conversationContext.userAmount.toFixed(2);
            state.conversationContext.userAmount = parseFloat(remainingAmount); // Atualiza o valor necessário com o saldo restante

            const messages = [
                `Valor a ser pago: *${formatToBRL(remainingAmount)}*`,
                'Segue abaixo a chave PIX para pagamento 👇',
                '00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
                'Por favor, envie o comprovante! 📄✅',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

            // Atualizar o estado no banco de dados
            const updatedContext = {
                ...state.conversationContext,
                currentStep: ConversationStep.WaitingForPayment,
            };

            await this.conversationService.updateConversation(conversationId, {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        } else if (assistanceResponses.some((response) => userMessage.includes(response))) {
            const messages = [
                '👨‍💼 Um de nossos atendentes já está a caminho para te ajudar!',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

            // Atualizar o estado no banco de dados
            const updatedContext = {
                ...state.conversationContext,
                currentStep: ConversationStep.PaymentAssistance,
            };

            await this.conversationService.updateConversation(conversationId, {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        } else {
            const messages = [
                'Desculpe, não entendi sua resposta.',
                'Por favor, escolha uma das opções abaixo:\n' +
                '1- Pagar valor restante.\n' +
                '2- Chamar um atendente.',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));
        }

        return sentMessages;
    }


    // 8. Payment Reminder
    private async handlePaymentReminder(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<string[]> {
        const sentMessages = [];
        const conversationId = state._id.toString();

        if (userMessage.includes('sim, preciso de ajuda')) {
            const messages = ['Entendido! 😊 Vamos encaminhar um de nossos atendentes para te ajudar.'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

            // Atualizar o estado no banco de dados com um estado de assistência
            const updatedContext = {
                ...state.conversationContext,
                currentStep: ConversationStep.PaymentAssistance,
            };

            await this.conversationService.updateConversation(conversationId, {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        } else if (userMessage.includes('sim, estou fazendo o pagamento')) {
            const messages = ['Entendido! 😊 Estamos no aguardo.'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

            // Atualizar o estado no banco de dados para aguardar pagamento
            const updatedContext = {
                ...state.conversationContext,
                currentStep: ConversationStep.WaitingForPayment,
            };

            await this.conversationService.updateConversation(conversationId, {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        } else if (userMessage.includes('não, irei pagar de forma convencional')) {
            const messages = [
                'Que pena! 😔 Se mudar de ideia, estamos por aqui para te ajudar! 😊',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

            // Atualizar o estado no banco de dados com um estado de erro relacionado à recusa
            const updatedContext = {
                ...state.conversationContext,
                currentStep: ConversationStep.PaymentDeclined,
            };

            await this.conversationService.updateConversation(conversationId, {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        } else {
            const messages = [
                'Por favor, nos informe se precisa de ajuda ou se está fazendo o pagamento.',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

            // Manter o estado no banco sem alterações relevantes, mas reforçando o estado atual
            const updatedContext = { ...state.conversationContext };

            await this.conversationService.updateConversation(conversationId, {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        }

        return sentMessages; // Retorna as mensagens enviadas
    }


    // 9. Feedback
    private async handleFeedback(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<string[]> {
        const sentMessages = [];
        const npsScore = parseInt(userMessage);
        const conversationId = state._id.toString();

        if (!isNaN(npsScore) && npsScore >= 0 && npsScore <= 10) {
            if (!state.conversationContext.feedback) {
                state.conversationContext.feedback = new FeedbackDTO();
            }
            state.conversationContext.feedback.npsScore = npsScore;

            if (npsScore < 10) {
                const messages = [
                    'Agradecemos muito pelo Feedback, e queremos sempre melhorar, o que você sente que faltou para o 10?',
                ];
                sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

                // Atualizar o estado para solicitar detalhes do feedback
                const updatedContext = {
                    ...state.conversationContext,
                    currentStep: ConversationStep.FeedbackDetail,
                };

                await this.conversationService.updateConversation(conversationId, {
                    userId: state.userId,
                    conversationContext: updatedContext,
                });
            } else {
                const messages = ['Muito obrigado pelo seu feedback! 😊'];
                sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

                // Atualizar o estado para finalizado
                const updatedContext = {
                    ...state.conversationContext,
                    currentStep: ConversationStep.Completed,
                };

                await this.conversationService.updateConversation(conversationId, {
                    userId: state.userId,
                    conversationContext: updatedContext,
                });
            }
        } else {
            const messages = ['Por favor, avalie de 0 a 10.'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

            // Reforçar o estado atual no banco
            const updatedContext = { ...state.conversationContext };

            await this.conversationService.updateConversation(conversationId, {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        }

        return sentMessages; // Retorna as mensagens enviadas
    }


    // 10. Feedback Detail
    private async handleFeedbackDetail(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<string[]> {
        const sentMessages = [];
        const detailedFeedback = userMessage; // Capture the user's detailed feedback
        const conversationId = state._id.toString();

        // Atualizar o feedback detalhado
        if (!state.conversationContext.feedback) {
            state.conversationContext.feedback = new FeedbackDTO();
        }
        state.conversationContext.feedback.detailedFeedback = detailedFeedback;

        const messages = [
            'Obrigado pelo seu feedback detalhado! 😊',
            'Se precisar de mais alguma coisa, estamos aqui para ajudar!',
        ];
        sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

        this.logger.log(`User ${from} provided detailed feedback: ${detailedFeedback}`);

        // Atualizar o estado para finalizado no banco de dados
        const updatedContext = {
            ...state.conversationContext,
            currentStep: ConversationStep.Completed,
        };

        await this.conversationService.updateConversation(conversationId, {
            userId: state.userId,
            conversationContext: updatedContext,
        });

        return sentMessages; // Retorna as mensagens enviadas
    }

}
