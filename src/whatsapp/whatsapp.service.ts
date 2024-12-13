// src/whatsapp/whatsapp.service.ts

import { Injectable, OnModuleInit, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import { TableService } from 'src/table/table.service';
import { LangchainService } from 'src/langchain/langchain.service';
import {
    BaseConversationDto,
    ConversationContextDTO,
    ConversationDto,
    CreateConversationDto,
    FeedbackDTO,
    MessageDTO,
} from '../conversation/dto/conversation.dto';
import { formatToBRL } from './utils/currency.utils';
import { ConversationService } from 'src/conversation/conversation.service';
import { CreateUserDto } from 'src/user/dto/user.dto';
import { UserService } from 'src/user/user.service';
import { ConversationStep, MessageType, PaymentStatus } from 'src/conversation/dto/conversation.enums';
import { OrderService } from 'src/order/order.service';
import { CreateOrderDTO } from 'src/order/dto/order.dto';
import { TransactionService } from 'src/transaction/transaction.service';
import { BaseTransactionDTO, CreateTransactionDTO, PaymentProofDTO, ReceivedPaymentDTO, TransactionDTO } from 'src/transaction/dto/transaction.dto';
import { table } from 'console';
import { GroupMessageKeys, GroupMessages } from './utils/group.messages.utils';
import { WhatsAppUtils } from './whatsapp.utils';
import { PaymentProcessorDTO } from './payment.processor';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
/**
 * The WhatsAppService class integrates with the WhatsApp Web API to manage conversations.
 * It handles incoming messages from authorized users, updates conversation states,
 * and delegates message handling to factory functions for different conversation steps.
 */
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
        private readonly orderService: OrderService,
        private readonly transactionService: TransactionService,
        private readonly utilsService: WhatsAppUtils,
        @InjectQueue('payment') private readonly paymentQueue: Queue
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
    // async onApplicationShutdown(signal?: string) {
    //     console.log('Shutting down WhatsApp Client...', signal);
    //     if (this.client) {
    //         try {
    //             await this.client.destroy();
    //             this.logger.log('WhatsApp Client and Puppeteer closed successfully.');
    //         } catch (error) {
    //             this.logger.error('Error closing WhatsApp Client:', error);
    //         }
    //     }
    // }

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
                '5511964681711@c.us',
                '5511974407410@c.us',
                '5511991879750@c.us'
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
                return; // Ignore old messagese
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
                    // await this.handlePaymentReminder(from, userMessage, state);
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

    private async handleOrderProcessing(
        from: string,
        userMessage: string,
        state: ConversationDto,
        message: Message,
    ): Promise<void> {
        const table_id = this.extractOrderId(userMessage);
        if (!table_id) {
            await message.reply(
                'Desculpe, não entendi o número da comanda. Por favor, diga "Gostaria de pagar a comanda X", onde X é o número da comanda.',
            );
            return;
        }

        const table_id_int = parseInt(table_id);
        const orderProcessingInfo = await this.isOrderBeingProcessed(table_id, from);

        if (!orderProcessingInfo.isProcessing) {
            // Iniciar processamento da comanda para o usuário atual
            const updatedContext: ConversationContextDTO = {
                ...state.conversationContext,
                currentStep: ConversationStep.ProcessingOrder,
            };

            const updatedConversation: ConversationDto = {
                _id: state._id,
                userId: state.userId,
                conversationContext: updatedContext,
            };

            await this.conversationService.updateConversation(state._id.toString(), updatedConversation);

            await message.reply(
                '👋 *Coti Pagamentos* - Que ótimo! Estamos processando sua comanda, por favor aguarde. 😁',
            );
            await this.handleProcessingOrder(from, state, table_id_int);
            return;
        }

        const { state: otherState, userNumber } = orderProcessingInfo;
        const lastMessageTime = otherState?.conversationContext?.lastMessage
            ? new Date(otherState.conversationContext.lastMessage).getTime()
            : 0;
        const currentTimeMs = Date.now();
        const timeSinceLastMessage = (currentTimeMs - lastMessageTime) / (1000 * 60);
        const inactivityThreshold = 5; // 5 minutos

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

            const updateConversationData: BaseConversationDto = {
                userId: state.userId,
                conversationContext: {
                    ...state.conversationContext,
                    currentStep: ConversationStep.ProcessingOrder,
                },
            };

            await this.conversationService.updateConversation(state._id.toString(), updateConversationData);
            await message.reply(
                '👋 *Coti Pagamentos* - Que ótimo! Estamos processando sua comanda, por favor aguarde. 😁',
            );

            this.notifyAttendantsTableStartedPayment(table_id_int); // There is not need to wait for this to finish, as we don't want to block the user
            await this.handleProcessingOrder(from, state, table_id_int);
        } else {
            const step = otherState?.conversationContext?.currentStep;
            const splittingSteps = [
                ConversationStep.SplitBill,
                ConversationStep.SplitBillNumber,
                ConversationStep.WaitingForContacts,
            ];
            if (step && splittingSteps.includes(step)) {
                await message.reply(
                    `Sua comanda está em processo de divisão de conta. O número *${userNumber}* está compartilhando os contatos para dividir a conta. Por favor, aguarde ou entre em contato com essa pessoa para participar da divisão.`,
                );
            } else {
                await message.reply(
                    'Desculpe, esta comanda já está sendo processada por outra pessoa.',
                );
            }
        }
    }

    /**
     * Step 1: Processing Order
     *
     * Processes the order details and updates the conversation state accordingly.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param state - The current state of the user's conversation.
     * @param order_id - The unique identifier of the order to be processed.
     * @returns A Promise that resolves to an array of strings representing the messages sent to the user.
     * 
     * Functionality: 
     * - Retrieves order details using the provided order ID.
     * - Sends the order details to the user for confirmation.
     * - Updates the conversation state to the confirmation step or sets an error state if the order is not found.
    */

    private async handleProcessingOrder(
        from: string,
        state: ConversationDto,
        tableId: number,
    ): Promise<string[]> {
        const conversationId = state._id.toString();
        try {
            const orderData = await this.retryRequestWithNotification({
                from: from,
                requestFunction: () => this.tableService.orderMessage(tableId),
                state: state,
            });

            const orderMessage = orderData.message;
            const orderDetails = orderData.details;

            const messages = [orderMessage, '👍 A sua comanda está correta?\n\n1- Sim\n2- Não'];
            const sentMessages = await this.sendMessageWithDelay(from, messages, state);

            const createOrderData: CreateOrderDTO = {
                tableId: tableId,
                items: orderDetails.orders,
                totalAmount: orderDetails.total,
                appliedDiscount: orderDetails.discount,
                amountPaidSoFar: 0,
            };

            const createdOrderData = await this.orderService.createOrder(createOrderData);

            const updateConversationData: BaseConversationDto = {
                userId: state.userId,
                tableId: tableId.toString(),
                orderId: createdOrderData.data._id.toString(),
                conversationContext: {
                    ...state.conversationContext,
                    currentStep: ConversationStep.ConfirmOrder,
                    totalOrderAmount: orderDetails.total,
                }
            };

            await this.conversationService.updateConversation(conversationId, updateConversationData);
            return sentMessages;
        } catch (error) {
            await this.conversationService.updateConversationWithErrorStatus(conversationId, ConversationStep.OrderNotFound);
        }
    }

    /**
 * Step 2: Confirm Order
 *
 * Handles the user's response to confirm the order details and updates the conversation state accordingly.
 *
 * @param from - The user's unique identifier (WhatsApp ID).
 * @param userMessage - The text message sent by the user to confirm the order.
 * @param state - The current state of the user's conversation.
 * @returns A Promise that resolves to an array of strings representing the messages sent to the user.
 * 
 * Functionality: 
 * - Analyzes the user's response to confirm or reject the order details.
 * - Updates the conversation state to the next step (Split Bill or Incomplete Order).
 * - Sends appropriate follow-up messages based on the user's response.
 */

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

            this.retryRequestWithNotification({
                from: from,
                requestFunction: () => this.tableService.startPayment(parseInt(state.tableId)),
                state: state,
                sendDelayNotification: false,
                groupMessage: GroupMessages[GroupMessageKeys.PREBILL_ERROR](state.tableId),
            })

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

        await this.conversationService.updateConversationContext(conversationId, updatedContext);

        return sentMessages;
    }

    /**
     * Step 3: Split Bill
     *
     * Handles the user's response regarding splitting the bill and updates the conversation state accordingly.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param userMessage - The text message sent by the user to indicate whether they want to split the bill.
     * @param state - The current state of the user's conversation.
     * @returns A Promise that resolves to an array of strings representing the messages sent to the user.
     * 
     * Functionality:
     * - Determines if the user wants to split the bill.
     * - Updates the conversation state to the next step (Split Bill Number or Extra Tip).
     * - Sends follow-up messages based on the user's decision to split or not split the bill.
     */

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

            // const transactionData: CreateTransactionDTO = {
            //     orderId: state.orderId,
            //     tableId: state.tableId,
            //     conversationId: state._id.toString(),
            //     userId: state.userId,
            //     amountPaid: 0,
            //     expectedAmount: updatedContext.userAmount,
            //     status: PaymentStatus.Pending,
            //     initiatedAt: new Date(),
            // }

            // await this.transactionService.createTransaction(transactionData);

        } else {
            const messages = ['Por favor, responda com 1 para Sim ou 2 para Não.'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));
        }

        return sentMessages;
    }

    /**
     * Step 4: Split Bill Number
     *
     * Handles the user's input to specify the number of people for splitting the bill and updates the conversation state.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param userMessage - The text message sent by the user indicating the number of people to split the bill with.
     * @param state - The current state of the user's conversation.
     * @returns A Promise that resolves to an array of strings representing the messages sent to the user.
     * 
     * Functionality:
     * - Extracts the number of people from the user's message.
     * - Updates the conversation state to wait for contact information if the input is valid.
     * - Sends a prompt to provide contact details for bill splitting.
     * - Sends an error message if the input is invalid.
     */

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

    /**
     * Step 5: Waiting for Contacts
     *
     * Handles the reception of contact details for splitting the bill and updates the conversation state.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param state - The current state of the user's conversation.
     * @param message - The message object containing metadata and contact information.
     * @returns A Promise that resolves to an array of strings representing the messages sent to the user.
     * 
     * Functionality:
     * - Processes vCard(s) sent by the user for contact information.
     * - Validates the number of contacts and ensures the required number is met.
     * - Updates the conversation state to continue processing the split bill.
     * - Sends appropriate messages for successfully received contacts or prompts for additional contacts.
     * - Handles errors when processing contact details.
     */

    // private async handleWaitingForContacts(
    //     from: string,
    //     state: ConversationDto,
    //     message: Message,
    // ): Promise<string[]> {
    //     const sentMessages = [];

    //     if (message.type === 'vcard' || message.type === 'multi_vcard') {
    //         try {
    //             const vcardDataArray = message.vCards;

    //             const contactsReceivedSoFar = state.conversationContext.splitInfo.contacts.length;
    //             const totalContactsExpected = state.conversationContext.splitInfo.numberOfPeople - 1;
    //             const remainingContactsNeeded = totalContactsExpected - contactsReceivedSoFar;

    //             if (remainingContactsNeeded <= 0) {
    //                 const messages = [
    //                     'Você já enviou todos os contatos necessários.',
    //                     'Vamos prosseguir com seu atendimento. 😄',
    //                 ];
    //                 sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

    //                 const updatedContext = {
    //                     ...state.conversationContext,
    //                     currentStep: ConversationStep.ExtraTip,
    //                 };
    //                 await this.conversationService.updateConversation(state._id.toString(), {
    //                     userId: state.userId,
    //                     conversationContext: updatedContext,
    //                 });

    //                 return sentMessages;
    //             }

    //             const vcardDataArrayLimited = vcardDataArray.slice(0, remainingContactsNeeded);

    //             let responseMessage = `✨ *Contato(s) Recebido(s) com Sucesso!* ✨\n`;

    //             const contactsToAdd = [];
    //             for (const vcardData of vcardDataArrayLimited) {
    //                 const vcardName = vcardData.split('FN:')[1]?.split('\n')[0] || 'Nome não informado';
    //                 let vcardPhone = vcardData.split('waid=')[1]?.split(':')[1]?.split('\n')[0] || '';
    //                 vcardPhone = vcardPhone.replace(/\D/g, '');

    //                 responseMessage += `\n👤 *Nome:* ${vcardName}\n📞 *Número:* ${vcardPhone}\n`;

    //                 contactsToAdd.push({
    //                     name: vcardName,
    //                     phone: vcardPhone,
    //                     individualAmount: 0,
    //                 });
    //             }

    //             state.conversationContext.splitInfo.contacts.push(...contactsToAdd);

    //             if (vcardDataArray.length > remainingContactsNeeded) {
    //                 responseMessage += `\n⚠️ Você enviou mais contatos do que o necessário.\nApenas o${remainingContactsNeeded > 1 ? 's primeiros' : ''} ${remainingContactsNeeded} contato${remainingContactsNeeded > 1 ? 's' : ''} foi${remainingContactsNeeded > 1 ? 'ram' : ''} considerado${remainingContactsNeeded > 1 ? 's' : ''}.`;
    //             }

    //             const totalContactsReceived = state.conversationContext.splitInfo.contacts.length;
    //             const remainingContacts = totalContactsExpected - totalContactsReceived;

    //             if (remainingContacts > 0) {
    //                 responseMessage += `\n🕒 Aguardando mais *${remainingContacts}* contato${remainingContacts > 1 ? 's' : ''} para continuar.`;
    //             } else {
    //                 if (vcardDataArray.length <= totalContactsExpected) {
    //                     responseMessage += `\n🎉 Todos os contatos foram recebidos! Vamos prosseguir com seu atendimento. 😄`;
    //                 }
    //                 state.conversationContext.currentStep = ConversationStep.ExtraTip;
    //             }

    //             sentMessages.push(...(await this.sendMessageWithDelay(from, [responseMessage], state)));

    //             if (remainingContacts <= 0) {
    //                 const { data: orderData } = await this.orderService.getOrder(state.orderId);
    //                 const totalAmount = orderData.totalAmount;
    //                 const numPeople = state.conversationContext.splitInfo.numberOfPeople;
    //                 const individualAmount = parseFloat((totalAmount / numPeople).toFixed(2));

    //                 const contacts = state.conversationContext.splitInfo.contacts.map((contact) => ({
    //                     ...contact,
    //                     individualAmount,
    //                 }));

    //                 const updatedConversationData: ConversationContextDTO = {
    //                     ...state.conversationContext,
    //                     splitInfo: {
    //                         ...state.conversationContext.splitInfo,
    //                         contacts,
    //                     },
    //                     currentStep: ConversationStep.ExtraTip,
    //                     userAmount: individualAmount,
    //                 };

    //                 const transactionData: CreateTransactionDTO = {
    //                     orderId: state.orderId,
    //                     tableId: state.tableId,
    //                     conversationId: state._id.toString(),
    //                     userId: state.userId,
    //                     amountPaid: 0,
    //                     expectedAmount: individualAmount,
    //                     status: PaymentStatus.Pending,
    //                     initiatedAt: new Date(),
    //                 }

    //                 await this.conversationService.updateConversation(state._id.toString(), {
    //                     userId: state.userId,
    //                     conversationContext: updatedConversationData,
    //                 });

    //                 await this.transactionService.createTransaction(transactionData);

    //                 for (const contact of contacts) {
    //                     const contactId = `${contact.phone}@c.us`;
    //                     const messages = [
    //                         `👋 Coti Pagamentos - Olá! Você foi incluído na divisão do pagamento da comanda *${state.tableId}* no restaurante Cris Parrilla. Aguarde para receber mais informações sobre o pagamento.`,
    //                         `Sua parte na conta é de *${formatToBRL(individualAmount)}*.`,
    //                         'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
    //                     ];

    //                     const contactConversationData: CreateConversationDto = {
    //                         userId: contactId,
    //                         tableId: state.tableId,
    //                         orderId: state.orderId,
    //                         referrerUserId: state.userId,
    //                         conversationContext: {
    //                             currentStep: ConversationStep.ExtraTip,
    //                             userAmount: individualAmount,
    //                             totalOrderAmount: totalAmount,
    //                             messages: [],
    //                         },
    //                     };

    //                     const { data: createConversationRequest } = await this.conversationService.createConversation(contactConversationData);
    //                     const createdConversationId = createConversationRequest._id;

    //                     const transactionData: CreateTransactionDTO = {
    //                         orderId: state.orderId,
    //                         tableId: state.tableId,
    //                         conversationId: createdConversationId,
    //                         userId: state.userId,
    //                         amountPaid: 0,
    //                         expectedAmount: individualAmount,
    //                         status: PaymentStatus.Pending,
    //                         initiatedAt: new Date(),
    //                     }

    //                     await this.transactionService.createTransaction(transactionData);

    //                     await this.sendMessageWithDelay(contactId, messages, state);
    //                 }

    //                 const messages = [
    //                     'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
    //                 ];
    //                 sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));
    //             }
    //         } catch (error) {
    //             this.logger.error('Erro ao processar o(s) vCard(s):', error);
    //             const errorMessages = [
    //                 '❌ Ocorreu um erro ao processar o contato. Por favor, tente novamente enviando o contato.',
    //             ];
    //             sentMessages.push(...(await this.sendMessageWithDelay(from, errorMessages, state)));
    //         }
    //     } else {
    //         const promptMessages = [
    //             '📲 Por favor, envie o contato da pessoa com quem deseja dividir a conta.',
    //         ];
    //         sentMessages.push(...(await this.sendMessageWithDelay(from, promptMessages, state)));
    //     }

    //     return sentMessages;
    // }

    private async handleWaitingForContacts(
        from: string,
        state: ConversationDto,
        message: Message,
    ): Promise<string[]> {
        const sentMessages: string[] = [];

        if (this.utilsService.isVcardMessage(message)) {
            try {
                const {
                    contactsNeeded,
                    remainingContactsNeeded,
                    totalContactsExpected,
                } = this.utilsService.calculateContactsNeeded(state);

                if (remainingContactsNeeded <= 0) {
                    // Já tem todos os contatos
                    return await this.handleAllContactsAlreadyReceived(from, state, sentMessages);
                }

                const extractedContacts = this.utilsService.extractContactsFromVcards(message, remainingContactsNeeded);
                this.utilsService.addExtractedContactsToState(state, extractedContacts);

                const responseMessage = this.buildContactsReceivedMessage(
                    extractedContacts,
                    message.vCards.length,
                    remainingContactsNeeded,
                    totalContactsExpected,
                    state
                );
                sentMessages.push(...(await this.sendMessageWithDelay(from, [responseMessage], state)));

                if (this.utilsService.haveAllContacts(state, totalContactsExpected)) {
                    await this.finalizeContactsReception(from, state, sentMessages);
                }

            } catch (error) {
                await this.handleVcardProcessingError(from, state, sentMessages, error);
            }
        } else {
            await this.promptForContact(from, state, sentMessages);
        }

        return sentMessages;
    }

    private async handleAllContactsAlreadyReceived(
        from: string,
        state: ConversationDto,
        sentMessages: string[]
    ): Promise<string[]> {
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

    private buildContactsReceivedMessage(
        contacts: { name: string; phone: string; individualAmount: number }[],
        totalVcardsSent: number,
        remainingContactsNeeded: number,
        totalContactsExpected: number,
        state: ConversationDto
    ): string {
        let responseMessage = `✨ *Contato(s) Recebido(s) com Sucesso!* ✨\n`;

        for (const contact of contacts) {
            responseMessage += `\n👤 *Nome:* ${contact.name}\n📞 *Número:* ${contact.phone}\n`;
        }

        if (totalVcardsSent > remainingContactsNeeded) {
            responseMessage += `\n⚠️ Você enviou mais contatos do que o necessário.\nApenas o${remainingContactsNeeded > 1 ? 's primeiros' : ''} ${remainingContactsNeeded} contato${remainingContactsNeeded > 1 ? 's' : ''} foi${remainingContactsNeeded > 1 ? 'ram' : ''} considerado${remainingContactsNeeded > 1 ? 's' : ''}.`;
        }

        const totalContactsReceived = state.conversationContext.splitInfo.contacts.length;
        const remainingContacts = totalContactsExpected - totalContactsReceived;

        if (remainingContacts > 0) {
            responseMessage += `\n🕒 Aguardando mais *${remainingContacts}* contato${remainingContacts > 1 ? 's' : ''} para continuar.`;
        } else {
            if (totalVcardsSent <= totalContactsExpected) {
                responseMessage += `\n🎉 Todos os contatos foram recebidos! Vamos prosseguir com seu atendimento. 😄`;
            }
            state.conversationContext.currentStep = ConversationStep.ExtraTip;
        }

        return responseMessage;
    }

    private async finalizeContactsReception(
        from: string,
        state: ConversationDto,
        sentMessages: string[]
    ): Promise<void> {
        const { data: orderData } = await this.orderService.getOrder(state.orderId);
        const totalAmount = orderData.totalAmount;
        const numPeople = state.conversationContext.splitInfo.numberOfPeople;
        const individualAmount = parseFloat((totalAmount / numPeople).toFixed(2));

        await this.updateConversationAndCreateTransaction(state, individualAmount, totalAmount);
        await this.notifyIncludedContacts(state, totalAmount, individualAmount);
        sentMessages.push(...(await this.sendMessageWithDelay(from, [
            'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
        ], state)));
    }

    private async updateConversationAndCreateTransaction(
        state: ConversationDto,
        individualAmount: number,
        totalAmount: number,
    ): Promise<void> {
        const contacts = state.conversationContext.splitInfo.contacts.map((contact) => ({
            ...contact,
            individualAmount,
        }));

        const updatedConversationData: ConversationContextDTO = {
            ...state.conversationContext,
            splitInfo: {
                ...state.conversationContext.splitInfo,
                contacts,
            },
            currentStep: ConversationStep.ExtraTip,
            userAmount: individualAmount,
        };

        // const transactionData: CreateTransactionDTO = {
        //     orderId: state.orderId,
        //     tableId: state.tableId,
        //     conversationId: state._id.toString(),
        //     userId: state.userId,
        //     amountPaid: 0,
        //     expectedAmount: individualAmount,
        //     status: PaymentStatus.Pending,
        //     initiatedAt: new Date(),
        // };

        await this.conversationService.updateConversation(state._id.toString(), {
            userId: state.userId,
            conversationContext: updatedConversationData,
        });

        // await this.transactionService.createTransaction(transactionData);
    }

    private async notifyIncludedContacts(
        state: ConversationDto,
        totalAmount: number,
        individualAmount: number
    ): Promise<void> {
        const contacts = state.conversationContext.splitInfo.contacts;

        for (const contact of contacts) {
            const contactId = `${contact.phone}@c.us`;
            const messages = [
                `👋 Coti Pagamentos - Olá! Você foi incluído na divisão do pagamento da comanda *${state.tableId}* no restaurante Cris Parrilla. Aguarde para receber mais informações sobre o pagamento.`,
                `Sua parte na conta é de *${formatToBRL(individualAmount)}*.`,
                'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
            ];

            const contactConversationData: CreateConversationDto = {
                userId: contactId,
                tableId: state.tableId,
                orderId: state.orderId,
                referrerUserId: state.userId,
                conversationContext: {
                    currentStep: ConversationStep.ExtraTip,
                    userAmount: individualAmount,
                    totalOrderAmount: totalAmount,
                    messages: [],
                },
            };

            const { data: createConversationRequest } = await this.conversationService.createConversation(contactConversationData);
            const createdConversationId = createConversationRequest._id;

            // const transactionData: CreateTransactionDTO = {
            //     orderId: state.orderId,
            //     tableId: state.tableId,
            //     conversationId: createdConversationId,
            //     userId: state.userId,
            //     amountPaid: 0,
            //     expectedAmount: individualAmount,
            //     status: PaymentStatus.Pending,
            //     initiatedAt: new Date(),
            // };

            // await this.transactionService.createTransaction(transactionData);
            await this.sendMessageWithDelay(contactId, messages, state);
        }
    }

    private async handleVcardProcessingError(
        from: string,
        state: ConversationDto,
        sentMessages: string[],
        error: any
    ): Promise<void> {
        this.logger.error('Erro ao processar o(s) vCard(s):', error);
        const errorMessages = [
            '❌ Ocorreu um erro ao processar o contato. Por favor, tente novamente enviando o contato.',
        ];
        sentMessages.push(...(await this.sendMessageWithDelay(from, errorMessages, state)));
    }

    private async promptForContact(
        from: string,
        state: ConversationDto,
        sentMessages: string[]
    ): Promise<void> {
        const promptMessages = [
            '📲 Por favor, envie o contato da pessoa com quem deseja dividir a conta.',
        ];
        sentMessages.push(...(await this.sendMessageWithDelay(from, promptMessages, state)));
    }



    /**
     * Step 6: Extra Tip
     *
     * Handles the user's decision on adding an extra tip and updates the conversation state.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param userMessage - The text message sent by the user indicating their tip preference.
     * @param state - The current state of the user's conversation.
     * @returns A Promise that resolves to an array of strings representing the messages sent to the user.
     * 
     * Functionality:
     * - Processes the user's input to determine the tip percentage.
     * - Calculates the total amount including the tip, or retains the original amount if no tip is chosen.
     * - Updates the conversation state to proceed to the payment step.
     * - Sends appropriate messages to confirm the user's choice and provide payment details.
     */

    // private async handleExtraTip(
    //     from: string,
    //     userMessage: string,
    //     state: ConversationDto,
    // ): Promise<string[]> {
    //     const sentMessages = [];
    //     const noTipKeywords = ['não', 'nao', 'n quero', 'não quero', 'nao quero'];
    //     const tipPercent = parseFloat(userMessage.replace('%', '').replace(',', '.'));

    //     const userAmount = state.conversationContext.userAmount;

    //     if (noTipKeywords.some((keyword) => userMessage.includes(keyword)) || tipPercent === 0) {
    //         const messages = [
    //             'Sem problemas!',
    //             `O valor final da sua conta é: *${formatToBRL(userAmount.toFixed(2))}*`,
    //             'Segue abaixo a chave PIX para pagamento 👇',
    //             '00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
    //             'Por favor, envie o comprovante! 📄✅',
    //         ];
    //         sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

    //         const updatedContext = {
    //             ...state.conversationContext,
    //             currentStep: ConversationStep.WaitingForPayment,
    //             paymentStartTime: Date.now(),
    //         };

    //         await this.conversationService.updateConversation(state._id.toString(), {
    //             userId: state.userId,
    //             conversationContext: updatedContext,
    //         });
    //     } else if (tipPercent > 0) {
    //         let tipResponse = '';
    //         if (tipPercent <= 3) {
    //             tipResponse = `Obrigado! 😊 \nVocê escolheu ${tipPercent}%. Cada contribuição conta e sua ajuda é muito apreciada pela nossa equipe! 🙌`;
    //         } else if (tipPercent > 3 && tipPercent <= 5) {
    //             tipResponse = `Obrigado! 😊 \nVocê escolheu ${tipPercent}%, a mesma opção da maioria das últimas mesas. Sua contribuição faz a diferença para a equipe! 💪`;
    //         } else if (tipPercent > 5 && tipPercent <= 7) {
    //             tipResponse = `Incrível! 😄 \nVocê escolheu ${tipPercent}%, uma gorjeta generosa! Obrigado por apoiar nossa equipe de maneira tão especial. 💫`;
    //         } else {
    //             tipResponse = `Obrigado pela sua generosidade! 😊`;
    //         }
    //         sentMessages.push(tipResponse);

    //         const totalAmountWithTip = userAmount * (1 + tipPercent / 100);
    //         console.log("User Amount: ", userAmount);
    //         console.log("Tip Percent: ", tipPercent);
    //         console.log("Total Amount With Tip: ", totalAmountWithTip);

    //         const paymentMessages = [
    //             `O valor final da sua conta é: *${formatToBRL(totalAmountWithTip.toFixed(2))}*`,
    //             'Segue abaixo a chave PIX para pagamento 👇',
    //             '00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
    //             'Por favor, envie o comprovante! 📄✅',
    //         ];
    //         sentMessages.push(...(await this.sendMessageWithDelay(from, paymentMessages, state)));

    //         const updatedContext: ConversationContextDTO = {
    //             ...state.conversationContext,
    //             currentStep: ConversationStep.WaitingForPayment,
    //             paymentStartTime: Date.now(),
    //             userAmount: totalAmountWithTip,
    //             tipAmount: totalAmountWithTip - userAmount,
    //         };

    //         await this.conversationService.updateConversation(state._id.toString(), {
    //             userId: state.userId,
    //             conversationContext: updatedContext,
    //         });
    //     } else {
    //         const messages = [
    //             'Por favor, escolha uma das opções de gorjeta: 3%, 5% ou 7%, ou diga que não deseja dar gorjeta.',
    //         ];
    //         sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));
    //     }

    //     const transactionData: CreateTransactionDTO = {
    //         orderId: state.orderId,
    //         tableId: state.tableId,
    //         conversationId: state._id.toString(),
    //         userId: state.userId,
    //         amountPaid: 0,
    //         expectedAmount: state.conversationContext.userAmount,
    //         status: PaymentStatus.Pending,
    //         initiatedAt: new Date(),
    //     };

    //     return sentMessages;
    // }

    private async handleExtraTip(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<string[]> {
        const sentMessages = [];
        const noTipKeywords = ['não', 'nao', 'n quero', 'não quero', 'nao quero'];
        const tipPercent = parseFloat(userMessage.replace('%', '').replace(',', '.'));

        if (this.isNoTip(userMessage, noTipKeywords) || tipPercent === 0) {
            await this.handleNoTip(from, state, sentMessages);
        } else if (tipPercent > 0) {
            await this.handleTipAmount(from, state, sentMessages, tipPercent);
        } else {
            await this.handleInvalidTip(from, state, sentMessages);
        }

        await this.createTransaction(state);

        return sentMessages;
    }

    private isNoTip(userMessage: string, noTipKeywords: string[]): boolean {
        return noTipKeywords.some((keyword) => userMessage.includes(keyword));
    }

    private async handleNoTip(
        from: string,
        state: ConversationDto,
        sentMessages: string[]
    ): Promise<void> {
        const userAmount = state.conversationContext.userAmount;

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
    }

    private async handleTipAmount(
        from: string,
        state: ConversationDto,
        sentMessages: string[],
        tipPercent: number
    ): Promise<void> {
        const userAmount = state.conversationContext.userAmount;
        const totalAmountWithTip = userAmount * (1 + tipPercent / 100);
        const tipResponse = this.getTipResponse(tipPercent);

        sentMessages.push(tipResponse);

        const paymentMessages = [
            `O valor final da sua conta é: *${formatToBRL(totalAmountWithTip.toFixed(2))}*`,
            'Segue abaixo a chave PIX para pagamento 👇',
            '00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
            'Por favor, envie o comprovante! 📄✅',
        ];
        sentMessages.push(...(await this.sendMessageWithDelay(from, paymentMessages, state)));

        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            currentStep: ConversationStep.WaitingForPayment,
            paymentStartTime: Date.now(),
            userAmount: totalAmountWithTip,
            tipAmount: totalAmountWithTip - userAmount,
        };

        await this.conversationService.updateConversation(state._id.toString(), {
            userId: state.userId,
            conversationContext: updatedContext,
        });

        // As the userAmount will be used to create the transaction, we need to update it in the conversation context
        state.conversationContext.userAmount = totalAmountWithTip;
    }

    private async handleInvalidTip(
        from: string,
        state: ConversationDto,
        sentMessages: string[]
    ): Promise<void> {
        const messages = [
            'Por favor, escolha uma das opções de gorjeta: 3%, 5% ou 7%, ou diga que não deseja dar gorjeta.',
        ];
        sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));
    }

    private getTipResponse(tipPercent: number): string {
        if (tipPercent <= 3) {
            return `Obrigado! 😊 \nVocê escolheu ${tipPercent}%. Cada contribuição conta e sua ajuda é muito apreciada pela nossa equipe! 🙌`;
        } else if (tipPercent > 3 && tipPercent <= 5) {
            return `Obrigado! 😊 \nVocê escolheu ${tipPercent}%, a mesma opção da maioria das últimas mesas. Sua contribuição faz a diferença para a equipe! 💪`;
        } else if (tipPercent > 5 && tipPercent <= 7) {
            return `Incrível! 😄 \nVocê escolheu ${tipPercent}%, uma gorjeta generosa! Obrigado por apoiar nossa equipe de maneira tão especial. 💫`;
        }
        return `Obrigado pela sua generosidade! 😊`;
    }

    private async createTransaction(state: ConversationDto): Promise<void> {
        const transactionData: CreateTransactionDTO = {
            orderId: state.orderId,
            tableId: state.tableId,
            conversationId: state._id.toString(),
            userId: state.userId,
            amountPaid: 0,
            expectedAmount: state.conversationContext.userAmount,
            status: PaymentStatus.Pending,
            initiatedAt: new Date(),
        };

        await this.transactionService.createTransaction(transactionData);
    }


    /**
     * Step 7: Waiting For Payment
     *
     * Handles the waiting-for-payment state of the conversation.
     * Checks if the user has sent a payment proof (text or media) and processes it accordingly.
     * If no proof is received within a certain time, sends a reminder.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param userMessage - The message sent by the user.
     * @param state - The current state of the user's conversation.
     * @param message - The received WhatsApp message object.
     * @returns An array of strings representing the messages sent to the user.
     *
     * Functionality:
     * - Checks if the user provided payment proof.
     * - If provided, processes the payment proof and updates conversation state.
     * - If no proof is received in time, sends a reminder message.
     */

    private async handleWaitingForPayment(
        from: string,
        userMessage: string,
        state: ConversationDto,
        message: Message,
    ): Promise<any> {
        let mediaData: string | null = null;
        if (message.hasMedia) {
            const media = await message.downloadMedia();
            if (media && media.data) {
                mediaData = media.data;
            }
        }

        const paymentMessageData: PaymentProcessorDTO = {
            from,
            userMessage,
            state,
            message,
            mediaData,
        };

        await this.paymentQueue.add(paymentMessageData);
    }


    public async processPayment(paymentData: PaymentProcessorDTO): Promise<string[]> {

        console.log("Payment Data: ", paymentData);

        const { from, userMessage, message, mediaData, state } = paymentData;

        const sentMessages: string[] = [];

        if (this.utilsService.userSentProof(userMessage, message)) {
            return await this.processPaymentProof(from, message, mediaData, state, sentMessages);
        } else {
            await this.remindIfNoProof(from, state, sentMessages);
        }

        return sentMessages;

    }

    /**
     * Step 7.1: Process Payment Proof
     *
     * Processes the payment proof (if media is attached), extracts and analyzes it.
     * Handles errors and sends appropriate responses.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param message - The received WhatsApp message object.
     * @param state - The current state of the user's conversation.
     * @param sentMessages - An array to accumulate messages sent to the user.
     * @returns A Promise that resolves to an array of messages sent to the user.
     *
     * Functionality:
     * - Downloads and analyzes payment proof media.
     * - Delegates analysis to a helper function.
     * - Sends error messages if processing fails.
     */
    private async processPaymentProof(
        from: string,
        message: Message,
        mediaData: string | null,
        state: ConversationDto,
        sentMessages: string[]
    ): Promise<string[]> {
        try {

            const analysisResult = await this.utilsService.extractAndAnalyzePaymentProof(
                mediaData,
                state,
            );
            return await this.handleProofAnalysisResult(from, state, sentMessages, analysisResult);


        }
        catch (error) {
            this.logger.error('Error processing payment proof:', error);
            const errorMessage = ['Desculpe, não conseguimos processar o comprovante de pagamento. Por favor, envie novamente.'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, errorMessage, state)));
        }
        return sentMessages;
    }

    /**
     * Step 7.2: Handle Proof Analysis Result
     *
     * Interprets the analysis result of the payment proof and decides the next conversation steps.
     * Handles duplicate, correct, overpaid, underpaid, or invalid beneficiary scenarios.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param state - The current state of the user's conversation.
     * @param sentMessages - An array to accumulate messages sent to the user.
     * @param analysisResult - The analyzed payment proof details.
     * @returns A Promise that resolves to an array of messages sent to the user.
     *
     * Functionality:
     * - Checks for duplicate proofs.
     * - Validates beneficiary and amount paid.
     * - Proceeds accordingly: confirms payment, requests decision on overpayment, or highlights under/overpayment.
     */
    private async handleProofAnalysisResult(
        from: string,
        state: ConversationDto,
        sentMessages: string[],
        paymentData: PaymentProofDTO
    ): Promise<string[]> {
        const isDuplicate = await this.transactionService.isPaymentProofTransactionIdDuplicate(
            state.userId,
            paymentData.id_transacao,
        );

        if (isDuplicate) {
            await this.handleDuplicateProof(from, state, sentMessages);
            return sentMessages;
        }

        const { activeTransaction, amountPaid } = await this.utilsService.buildPaymentData(
            state,
            paymentData
        );
        const isBeneficiaryCorrect = this.utilsService.validateBeneficiary(paymentData);
        const isAmountCorrect = amountPaid === activeTransaction.expectedAmount;
        const isOverpayment = amountPaid > activeTransaction.expectedAmount;

        const updateTransactionData: TransactionDTO = {
            ...activeTransaction,
            amountPaid: amountPaid,
            paymentProofs: [paymentData]
        }

        if (!isBeneficiaryCorrect) {
            await this.handleInvalidBeneficiary(from, state, sentMessages);
        } else if (isAmountCorrect) {
            await this.handleCorrectPayment(from, state, sentMessages, updateTransactionData);
        } else if (isOverpayment) {
            await this.handleOverpayment(from, state, sentMessages, updateTransactionData, amountPaid);
        } else {
            await this.handleUnderpayment(from, state, sentMessages, updateTransactionData, amountPaid);
        }

        // In this region the payment made by the user has already been processed.
        // As a result, it is the right time to check if the paid amount is greater or equal to the expected amount.
        // Methods that must be called after the payment has been processed should be placed here.
        //
        // 1. Update `amountPaidSoFar` in the `Order` collection + Check if the order is paid

        if (await this.orderService.updateAmountPaidAndCheckOrderStatus(state.orderId, amountPaid)) {
            await this.tableService.finishPayment(parseInt(state.tableId));
        }

        return sentMessages;
    }

    /**
     * Step 7.2.1: Handle Duplicate Proof
     *
     * Notifies the user that the payment proof has already been used previously.
     * Updates the conversation state accordingly.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param state - The current state of the user's conversation.
     * @param sentMessages - An array to accumulate messages sent to the user.
     * @returns A Promise that resolves to void.
     *
     * Functionality:
     * - Sends a message informing the user about the duplicate proof.
     * - No status updates to the transaction since the proof is invalid.
     */
    private async handleDuplicateProof(
        from: string,
        state: ConversationDto,
        sentMessages: string[],
    ): Promise<void> {
        const duplicateMessage = [
            '❌ Este comprovante de pagamento já foi recebido anteriormente.\n\n Por favor, verifique seu comprovante.',
        ];
        sentMessages.push(...(await this.sendMessageWithDelay(from, duplicateMessage, state)));
    }

    /**
     * Step 7.3: Remind If No Proof
     *
     * Checks if sufficient time has passed without receiving a payment proof,
     * and sends a reminder message if needed.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param state - The current state of the user's conversation.
     * @param sentMessages - An array to accumulate messages sent to the user.
     * @returns A Promise that resolves to void.
     *
     * Functionality:
     * - Calculates elapsed time since payment start.
     * - Sends a reminder if no proof is received within a defined timeframe.
     */
    private async remindIfNoProof(
        from: string,
        state: ConversationDto,
        sentMessages: string[]
    ): Promise<void> {
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

    /**
     * Step 7.2.2: Handle Invalid Beneficiary
     *
     * Informs the user that the sent proof does not match the expected beneficiary.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param state - The current state of the user's conversation.
     * @param sentMessages - An array to accumulate messages sent to the user.
     * @returns A Promise that resolves to void.
     *
     * Functionality:
     * - Sends a message indicating invalid beneficiary.
     * - Updates the conversation state to reflect the invalid payment attempt.
     */
    private async handleInvalidBeneficiary(
        from: string,
        state: ConversationDto,
        sentMessages: string[],
    ): Promise<void> {
        const errorMessage = [
            '❌ O comprovante enviado apresenta inconsistências.\n👨‍💼 Um de nossos atendentes está a caminho para te ajudar!',
        ];
        sentMessages.push(...(await this.sendMessageWithDelay(from, errorMessage, state)));

        const updatedContext = {
            ...state.conversationContext,
            currentStep: ConversationStep.PaymentInvalid,
        };

        await this.conversationService.updateConversation(
            state._id.toString(),
            { userId: state.userId, conversationContext: updatedContext },
        );
    }

    /**
     * Step 7.2.3: Handle Correct Payment
     *
     * Confirms the payment, thanks the user, and requests feedback.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param state - The current state of the user's conversation.
     * @param sentMessages - An array to accumulate messages sent to the user.
     * @param updateTransactionData - The updated transaction data.
     * @param amountPaid - The amount paid by the user.
     * @returns A Promise that resolves to void.
     *
     * Functionality:
     * - Confirms the payment.
     * - Sends a thank-you message and requests user feedback.
     * - Updates the transaction status and conversation state.
     */
    private async handleCorrectPayment(
        from: string,
        state: ConversationDto,
        sentMessages: string[],
        updateTransactionData: TransactionDTO,
    ): Promise<void> {
        const messages = [
            'Pagamento confirmado.',
            'Muito obrigado por utilizar a *Coti* e realizar pagamentos mais *rápidos* 🙏',
            'Esperamos que sua experiência tenha sido excelente. Sua satisfação é muito importante para nós e estamos sempre prontos para te atender novamente! 😊',
            'Sua opinião é essencial para nós! Queremos saber:\n\nEm uma escala de 0 a 10, o quanto você recomendaria a Coti para amigos ou colegas?\n(0 = nada provável e 10 = muito provável)',
        ];
        sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            currentStep: ConversationStep.Feedback,
        };

        await this.conversationService.updateConversation(
            state._id.toString(),
            { userId: state.userId, conversationContext: updatedContext },
        );

        updateTransactionData.status = PaymentStatus.Confirmed;

        await this.transactionService.updateTransaction(
            updateTransactionData._id.toString(),
            updateTransactionData
        );

        // this.retryRequestWithNotification({
        //     from: from,
        //     requestFunction: () => this.tableService.finishPayment(parseInt(state.tableId)),
        //     state: state,
        //     sendDelayNotification: false,
        //     groupMessage: GroupMessages[GroupMessageKeys.FINISH_PAYMENT_ERROR](state.tableId),
        // })
    }

    /**
     * Step 7.2.4: Handle Overpayment
     *
     * Notifies the user that they overpaid and presents options to keep the excess as a tip or request a refund.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param state - The current state of the user's conversation.
     * @param sentMessages - An array to accumulate messages sent to the user.
     * @param updateTransactionData - The updated transaction data.
     * @param amountPaid - The amount paid by the user.
     * @returns A Promise that resolves to void.
     *
     * Functionality:
     * - Informs the user about the overpayment.
     * - Asks the user if they want to add the excess as a tip or request a refund.
     * - Updates the conversation state to reflect the user's next decision step.
     */
    private async handleOverpayment(
        from: string,
        state: ConversationDto,
        sentMessages: string[],
        updateTransactionData: TransactionDTO,
        amountPaid: number,
    ): Promise<void> {
        const excessAmount = amountPaid - state.conversationContext.userAmount;
        const messages = [
            `❌ Você pagou um valor superior ao necessário: *${formatToBRL(amountPaid)}* ao invés de *${formatToBRL(state.conversationContext.userAmount)}*.`,
            `Você deseja:\n\n1- Adicionar o valor excedente de *${formatToBRL(excessAmount)}* como gorjeta.\n2- Solicitar o estorno do valor extra.`,
        ];
        sentMessages.push(...(await this.sendMessageWithDelay(from, messages, state)));

        const updatedContext = {
            ...state.conversationContext,
            currentStep: ConversationStep.OverpaymentDecision,
            excessPaymentAmount: excessAmount,
        };

        await this.conversationService.updateConversation(
            state._id.toString(),
            { userId: state.userId, conversationContext: updatedContext },
        );

        updateTransactionData.status = PaymentStatus.Overpaid;

        await this.transactionService.updateTransaction(
            updateTransactionData._id.toString(),
            updateTransactionData
        );
    }

    /**
     * Step 7.2.5: Handle Underpayment
     *
     * Informs the user that they underpaid and provides options to pay the remaining amount or request assistance.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param state - The current state of the user's conversation.
     * @param sentMessages - An array to accumulate messages sent to the user.
     * @param updateTransactionData - The updated transaction data.
     * @param amountPaid - The amount paid by the user.
     * @returns A Promise that resolves to void.
     *
     * Functionality:
     * - Informs the user about the underpayment.
     * - Provides options to pay the remaining balance or seek help.
     * - Updates the conversation state and transaction status accordingly.
     */
    private async handleUnderpayment(
        from: string,
        state: ConversationDto,
        sentMessages: string[],
        updateTransactionData: TransactionDTO,
        amountPaid: number,
    ): Promise<void> {
        const remainingAmount = state.conversationContext.userAmount - amountPaid;
        const errorMessage = [
            `❌ O valor pago foi de ${formatToBRL(amountPaid)} enquanto deveria ser ${formatToBRL(state.conversationContext.userAmount)}.`,
            `💰 Você ainda tem um saldo de ${formatToBRL(remainingAmount)} a pagar.\n\nEscolha uma das opções abaixo:\n1- Pagar valor restante.\n2- Chamar um atendente.`,
        ];
        sentMessages.push(...(await this.sendMessageWithDelay(from, errorMessage, state)));

        const updatedContext = {
            ...state.conversationContext,
            currentStep: ConversationStep.AwaitingUserDecision,
            userAmount: remainingAmount,
        };

        await this.conversationService.updateConversation(
            state._id.toString(),
            { userId: state.userId, conversationContext: updatedContext },
        );

        updateTransactionData.status = PaymentStatus.Underpaid;

        await this.transactionService.updateTransaction(
            updateTransactionData._id.toString(),
            updateTransactionData
        );
    }

    /**
     * Step 8: Overpayment Decision
     *
     * Handles the user's decision regarding overpayment and updates the conversation state.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param userMessage - The text message sent by the user, indicating their choice for the overpaid amount.
     * @param state - The current state of the user's conversation.
     * @returns A Promise that resolves to an array of strings representing the messages sent to the user.
     * 
     * Functionality:
     * - Processes the user's input to either add the excess amount as a tip or request a refund.
     * - Updates the conversation state to proceed to the feedback step.
     * - Sends follow-up messages confirming the user's choice and thanking them for their decision.
     * - Handles invalid responses by prompting the user with available options.
     */

    private async handleOverpaymentDecision(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<string[]> {
        const sentMessages = [];
        // const excessAmount = state.conversationContext.excessPaymentAmount;
        const { data: transactionData } = await this.transactionService.getLastOverpaidTransactionByUserAndOrder(state.userId, state.orderId);
        const excessAmount = transactionData.amountPaid - transactionData.expectedAmount;
        const transactionId = transactionData._id.toString();
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

            const alreadyPaidTip = state.conversationContext.tipAmount || 0;

            const updatedContext: ConversationContextDTO = {
                ...state.conversationContext,
                currentStep: ConversationStep.Feedback,
                tipAmount: alreadyPaidTip + excessAmount,
            };

            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: updatedContext,
            });

            await this.transactionService.changeTransactionStatusToConfirmed(transactionId);
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

            // TODO: Enviar Mensagem para o time de suporte para processar o estorno

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

    /**
 * Step 9: Awaiting User Decision
 *
 * Handles the user's response regarding the next step for incomplete payments and updates the conversation state.
 *
 * @param from - The user's unique identifier (WhatsApp ID).
 * @param userMessage - The text message sent by the user indicating their decision.
 * @param state - The current state of the user's conversation.
 * @returns A Promise that resolves to an array of strings representing the messages sent to the user.
 * 
 * Functionality:
 * - Processes the user's input to either proceed with a new transaction to pay the remaining amount or request assistance.
 * - Updates the conversation state to either `WaitingForPayment` or `PaymentAssistance`.
 * - Sends follow-up messages with payment details or assistance confirmation.
 * - Handles invalid responses by prompting the user with the available options again.
 */

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
            console.log("Waiting User Decision. UserId: ", state.userId, "OrderId: ", state.orderId);
            const { data: transactionData } = await this.transactionService.getLastUnderpaidTransactionByUserAndOrder(state.userId, state.orderId);
            console.log("TransactionData: ", transactionData);
            // const remainingAmount = transactionData.expectedAmount - transactionData.amountPaid;
            const remainingAmount = state.conversationContext.userAmount - transactionData.amountPaid;
            const transactionId = transactionData._id.toString();
            state.conversationContext.userAmount = remainingAmount; // Atualiza o valor necessário com o saldo restante

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

            await this.transactionService.changeTransactionStatusToConfirmed(transactionId);

            const newTransactionData: CreateTransactionDTO = {
                orderId: state.orderId,
                tableId: state.tableId,
                conversationId: conversationId,
                userId: state.userId,
                amountPaid: 0,
                expectedAmount: remainingAmount,
                status: PaymentStatus.Pending,
                initiatedAt: new Date(),
            }

            await this.transactionService.createTransaction(newTransactionData);

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

    /**
     * Step 10: Payment Reminder
     *
     * Handles the user's response to a payment reminder and updates the conversation state accordingly.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param userMessage - The text message sent by the user, indicating their status regarding the payment.
     * @param state - The current state of the user's conversation.
     * @returns A Promise that resolves to an array of strings representing the messages sent to the user.
     * 
     * Functionality:
     * - Processes the user's input to determine whether they need assistance, are making the payment, or prefer an alternative method.
     * - Updates the conversation state to:
     *   - `PaymentAssistance` if the user requests help.
     *   - `WaitingForPayment` if the user confirms they are proceeding with the payment.
     *   - `PaymentDeclined` if the user decides to pay conventionally.
     * - Sends follow-up messages based on the user's response.
     * - Handles invalid responses by prompting the user for clarification.
     */

    private async handlePaymentReminder(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<string[]> {


        return [];
    }

    /**
     * Step 11: Feedback
     *
     * Handles the user's feedback for the service, capturing their NPS score and updating the conversation state.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param userMessage - The text message sent by the user, containing their feedback score (0-10).
     * @param state - The current state of the user's conversation.
     * @returns A Promise that resolves to an array of strings representing the messages sent to the user.
     * 
     * Functionality:
     * - Validates the user's NPS score (0-10) from their response.
     * - Updates the feedback data in the conversation context:
     *   - Requests additional feedback details if the score is less than 10.
     *   - Completes the feedback process if the score is 10.
     * - Sends appropriate follow-up messages based on the user's response.
     * - Prompts for a valid score if the user's input is invalid.
     */

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

    /**
     * Step 12: Feedback Detail
     *
     * Handles the user's detailed feedback submission and updates the conversation state.
     *
     * @param from - The user's unique identifier (WhatsApp ID).
     * @param userMessage - The detailed feedback message provided by the user.
     * @param state - The current state of the user's conversation.
     * @returns A Promise that resolves to an array of strings representing the messages sent to the user.
     * 
     * Functionality:
     * - Captures and logs the user's detailed feedback.
     * - Updates the feedback data in the conversation context with the provided details.
     * - Sends follow-up messages to thank the user and offer further assistance.
     * - Marks the conversation as completed after processing the detailed feedback.
     */

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


    /**
     * Sends payment confirmation details to the attendants or restaurant group chat.
     *
     * @param state - The current state of the conversation containing payment and order details.
     * @returns A Promise that resolves once the message has been sent to the group.
     *
     * Functionality:
     * - Retrieves the group chat based on its name.
     * - Generates a detailed message about the payment status, including:
     *   - Total amount and order ID.
     *   - Payment division status (individual or shared).
     *   - Individual payment progress for each participant if the bill is split.
     * - Handles both complete and partial payments.
     * - Logs the status of the message delivery or errors in case of failure.
     */

    private async sendPaymentConfirmationToAttendants(state: ConversationDto): Promise<void> {
        const groupName = 'Grupo Teste';

        try {
            const chats = await this.client.getChats();
            const groupChat = chats.find(chat => chat.isGroup && chat.name === groupName);

            if (groupChat) {
                let message = '';

                const orderId = state.orderId;
                const tableId = state.tableId;

                const { data: orderData } = await this.orderService.getOrder(orderId);

                const totalAmount = orderData.totalAmount;

                if (state.conversationContext.splitInfo && state.conversationContext.splitInfo.numberOfPeople > 1) {
                    const splitInfo = state.conversationContext.splitInfo;
                    const numberOfPeople = splitInfo.numberOfPeople;
                    const contacts = splitInfo.contacts;

                    message += `🧾 *Comanda ${tableId}* está sendo paga de forma compartilhada.\n`;
                    message += `Total a ser pago: ${formatToBRL(totalAmount)}\n\n`;
                    message += `👥 *Divisão entre ${numberOfPeople} pessoas:*\n`;

                    const currentUserName = 'Cliente';
                    const userAmount = state.conversationContext.userAmount;

                    const { data: totalPaid } = await this.transactionService.getTotalPaidByUserAndOrderId(state.userId, orderId);
                    const totalPaidByUser = totalPaid.totalPaid || 0;
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

                            const { data: totalPaid } = await this.transactionService.getTotalPaidByUserAndOrderId(contactId, orderId);
                            totalPaidByContact = totalPaid.totalPaid || 0;

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

                    const { data: totalPaid } = await this.transactionService.getTotalPaidByUserAndOrderId(state.userId, orderId);
                    const totalPaidByUser = totalPaid.totalPaid || 0;

                    const remainingAmount = userAmount - totalPaidByUser;

                    if (remainingAmount > 0) {
                        // Usuário pagou menos do que deveria
                        message += `⚠️ *Comanda ${tableId} paga parcialmente*\n`;
                        message += `• ${currentUserName} deveria pagar: ${formatToBRL(userAmount)}\n`;
                        message += `• Pagou: ${formatToBRL(totalPaidByUser)}\n`;
                        message += `• Restante a pagar: ${formatToBRL(remainingAmount)}\n\n`;
                    } else if (remainingAmount < 0) {
                        // Usuário pagou mais do que deveria
                        message += `⚠️ *Comanda ${tableId} paga com valor excedente*\n`;
                        message += `• ${currentUserName} deveria pagar: ${formatToBRL(userAmount)}\n`;
                        message += `• Pagou: ${formatToBRL(totalPaidByUser)}\n`;
                        message += `• Excedente: ${formatToBRL(-remainingAmount)}\n\n`;
                    } else {
                        // Pagamento completo
                        message += `✅ *Comanda ${tableId} paga em totalidade*\n`;
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

    /**
     * Sends an authentication status message to a designated group chat.
     *
     * @param message - The text message to be sent to the group.
     * @returns A Promise that resolves once the message has been sent to the group.
     *
     * Functionality:
     * - Locates the group chat by its name.
     * - Sends the provided authentication status message to the group.
     * - Logs success or warns if the group is not found.
     * - Handles and logs any errors that occur during the message-sending process.
     */

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

    /**
     * Forwards a payment proof message to a designated group chat.
     *
     * @param proofMessage - The message object containing the payment proof to be forwarded.
     * @returns A Promise that resolves once the message has been forwarded to the group.
     *
     * Functionality:
     * - Locates the group chat by its name.
     * - Forwards the provided payment proof message to the group chat.
     * - Logs success if the message is forwarded or warns if the group is not found.
     * - Handles and logs any errors encountered during the forwarding process.
     */

    private async sendProofToGroup(proofMessage: Message): Promise<void> {
        // Nome do grupo
        // const groupName = 'Coti + Cris Parrilla [COMPROVANTES]';
        const groupName = 'Grupo Teste';

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

    /**
     * Notifies attendants in a designated group chat that a table has started the payment process.
     *
     * @param tableNumber - The number of the table that initiated the payment process.
     * @returns A Promise that resolves once the notification has been sent to the group.
     *
     * Functionality:
     * - Locates the group chat by its name.
     * - Sends a notification message with the table number to the group chat.
     * - Logs success if the message is sent or warns if the group is not found.
     * - Handles and logs any errors that occur during the message-sending process.
     */

    private async notifyAttendantsTableStartedPayment(tableNumber: number): Promise<void> {
        const groupName = 'Grupo Teste';

        try {
            const chats = await this.client.getChats();
            const groupChat = chats.find(chat => chat.isGroup && chat.name === groupName);

            if (groupChat) {
                const message = `👋 *Coti Pagamentos* - A mesa ${tableNumber} iniciou o processo de pagamentos.`;
                await this.client.sendMessage(groupChat.id._serialized, message);
                this.logger.log(`Notificação de início de pagamentos enviada para o grupo: ${groupName}`);
            } else {
                this.logger.warn(`Grupo "${groupName}" não encontrado para notificação de início de pagamentos.`);
            }
        } catch (error) {
            this.logger.error(`Erro ao enviar notificação de início de pagamentos para o grupo ${groupName}: ${error}`);
        }
    }


    /**
     * Extracts the order ID from a given message.
     *
     * @param message - The input message string containing the order ID.
     * @returns The extracted order ID as a string if found, otherwise `null`.
     *
     * Functionality:
     * - Uses a regular expression to search for the word "comanda" followed by a number.
     * - Returns the number as a string if a match is found.
     * - Returns `null` if no match is detected in the message.
     */

    private extractOrderId(message: string): string | null {
        const match = message.match(/\bcomanda\s*(\d+)/i);
        return match ? match[1] : null;
    }

    /**
     * Checks if a specific order is currently being processed by another user.
     *
     * @param order_id - The ID of the order to check.
     * @param from - The unique identifier (WhatsApp ID) of the current user.
     * @returns A Promise that resolves to an object containing:
     *          - `isProcessing`: Boolean indicating whether the order is being processed.
     *          - `state`: The conversation state of the user processing the order (if applicable).
     *          - `userNumber`: The number of the user processing the order (if applicable).
     *
     * Functionality:
     * - Retrieves all active conversations related to the given `order_id` except for the current user's.
     * - Checks if any conversation is actively processing the order by verifying its step and context.
     * - Returns details about the conversation state and user processing the order if found.
     * - Returns `isProcessing: false` if no active processing is detected for the order.
     */

    private async isOrderBeingProcessed(
        orderId: string,
        from: string,
    ): Promise<{ isProcessing: boolean; state?: ConversationDto; userNumber?: string }> {
        // Busca todas as conversas ativas relacionadas ao orderId
        const activeConversationsResponse = await this.conversationService.getActiveConversationsByOrderId(parseInt(orderId));
        const activeConversations = activeConversationsResponse.data;

        for (const conversation of activeConversations) {
            const conversationContext = conversation.conversationContext;

            if (!conversationContext || !conversationContext.currentStep) {
                continue;
            }

            const currentStep = conversationContext.currentStep;

            // Verifica se a conversa está associada ao mesmo pedido e se não pertence ao usuário atual
            if (
                conversation.orderId === orderId && // Agora usamos diretamente o campo orderId do ConversationDto
                conversation.userId !== from && // Exclui a conversa do usuário atual
                ![ConversationStep.Completed, ConversationStep.IncompleteOrder].includes(currentStep) // Etapas a serem excluídas
            ) {
                const userNumber = conversation.userId.split('@')[0];
                return { isProcessing: true, state: conversation, userNumber };
            }
        }

        return { isProcessing: false };
    }


    /**
     * Retries a request function multiple times with a delay between attempts, sending notifications if failures occur.
     *
     * @param from - The unique identifier (WhatsApp ID) of the current user.
     * @param requestFunction - A function that performs the desired request and returns a Promise.
     * @param state - The current state of the user's conversation.
     * @returns A Promise that resolves with the result of the `requestFunction` if successful, or throws an error after all retries.
     *
     * Functionality:
     * - Attempts to execute the `requestFunction` up to a maximum number of retries (`maxRetries`).
     * - Logs and handles errors after each failed attempt.
     * - Sends delay notifications to the user after a specific number of failures (e.g., 3).
     * - Sends an alert to a group chat in case of persistent failures.
     * - Sends an error message to the user if all retries are exhausted and throws a "Max retries reached" error.
     */

    private async retryRequestWithNotification({
        from,
        requestFunction,
        state,
        sendDelayNotification = true,
        groupMessage = GroupMessages[GroupMessageKeys.AUTHENTICATION_ERROR](),
        delayNotificationThreshold = 3,
        delayBetweenRetries = 30000,
        maxRetries = 5,
    }: {
        from: string;
        requestFunction: () => Promise<any>;
        state: ConversationDto;
        sendDelayNotification?: boolean;
        groupMessage?: string;
        delayNotificationThreshold?: number;
        delayBetweenRetries?: number;
        maxRetries?: number;
    }): Promise<any> {
        let attempts = 0;

        while (attempts < maxRetries) {
            try {
                return await requestFunction();
            } catch (error) {
                attempts++;
                this.logger.error(
                    `Attempt ${attempts} failed for user ${from} at stage ${state.conversationContext.currentStep}. Error: ${error}`
                );

                if (attempts === delayNotificationThreshold && sendDelayNotification) {
                    const delayMessage = this.getDelayMessage(state.conversationContext.currentStep);
                    await this.sendMessageWithDelay(from, [delayMessage], state);
                }

                if (attempts < maxRetries) {
                    await new Promise((resolve) => setTimeout(resolve, delayBetweenRetries));
                }

                this.sendAuthenticationStatusToGroup(groupMessage);
            }
        }

        const errorMessage = this.generateStageErrorMessage(state.conversationContext.currentStep);
        await this.sendMessageWithDelay(from, [errorMessage], state);

        throw new Error("Max retries reached");
    }


    /**
     * Generates a delay notification message based on the current step of the conversation.
     *
     * @param currentStep - The current step of the conversation workflow.
     * @returns A string containing a user-friendly message indicating the delay for the given step.
     *
     * Functionality:
     * - Maps each conversation step to a predefined delay message.
     * - Provides a default message for unrecognized steps.
     * - Ensures the user is informed about delays in a clear and courteous manner.
     */

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

    /**
     * Sends multiple messages to a user with a delay between each message.
     *
     * @param from - The unique identifier (WhatsApp ID) of the recipient.
     * @param messages - An array of strings containing the messages to be sent.
     * @param state - The current state of the user's conversation.
     * @param delay - The delay in milliseconds between sending each message (default: 2000ms).
     * @returns A Promise that resolves to an array of the sent messages.
     *
     * Functionality:
     * - Iterates through the `messages` array, sending each message with a specified delay.
     * - In `DEBUG` mode, simulates sending messages by logging them instead of actually sending.
     * - Logs each message in the database using `MessageDTO`.
     * - Ensures that all sent messages are recorded in the conversation's history.
     */

    private async sendMessageWithDelay(
        from: string,
        messages: string[],
        state: ConversationDto,
        delay: number = 2000,
    ): Promise<string[]> {
        const sentMessages = [];
        const messageLogs: MessageDTO[] = []; // Lista para registrar mensagens no banco

        console.log("Delay Message to: ", from, messages);

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

    /**
     * Generates an error message for a specific stage of the conversation workflow.
     *
     * @param currentStep - The current step of the conversation workflow.
     * @returns A string containing a user-friendly error message based on the current step.
     *
     * Functionality:
     * - Maps each conversation step to a predefined error message.
     * - Provides a default error message for unrecognized steps.
     * - Ensures users are informed about errors in a professional and supportive manner, with a notice that assistance is on the way.
     */

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

    /**
     * Calculates the user's portion of the total order amount.
     *
     * @param state - The current conversation state containing order details and split information.
     * @returns The calculated amount each user needs to pay, formatted to two decimal places.
     *
     * Functionality:
     * - Retrieves the total order amount from the state.
     * - Ensures split information exists, defaulting to one person if not provided.
     * - Divides the total amount equally among the specified number of people.
     * - Returns the calculated share as a precise floating-point number.
     */

    private calculateUserAmount(state: ConversationDto): number {
        const totalAmount = state.conversationContext.totalOrderAmount;

        if (!state.conversationContext.splitInfo) {
            state.conversationContext.splitInfo = { numberOfPeople: 1, contacts: [] };
        }

        const numPeople = state.conversationContext.splitInfo.numberOfPeople || 1;
        return parseFloat((totalAmount / numPeople).toFixed(2));
    }

}
