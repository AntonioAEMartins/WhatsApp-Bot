import { Injectable, Logger, Inject, HttpException, HttpStatus, forwardRef } from '@nestjs/common';
import { TableService } from 'src/table/table.service';
import {
    BaseConversationDto,
    ConversationContextDTO,
    ConversationDto,
    CreateConversationDto,
    FeedbackDTO,
    ParticipantDTO,
    SplitInfoDTO,
} from '../conversation/dto/conversation.dto';
import { formatToBRL } from './utils/currency.utils';
import { ConversationService } from 'src/conversation/conversation.service';
import { CreateUserDto } from 'src/user/dto/user.dto';
import { UserService } from 'src/user/user.service';
import { ConversationStep, MessageType, PaymentStatus } from 'src/conversation/dto/conversation.enums';
import { OrderService } from 'src/order/order.service';
import { CreateOrderDTO } from 'src/order/dto/order.dto';
import { TransactionService } from 'src/transaction/transaction.service';
import { CreateTransactionDTO, PaymentMethod, PaymentProcessorDTO, TransactionDTO } from 'src/transaction/dto/transaction.dto';
import { GroupMessageKeys, GroupMessages } from './utils/group.messages.utils';
import { MessageUtils } from './message.utils';
import { Db, MongoClient, ObjectId } from 'mongodb';
import { ClientProvider } from 'src/db/db.module';
import { UserPaymentCreditInfoDto, UserPaymentPixInfoDto } from 'src/payment-gateway/dto/ipag-pagamentos.dto';
import { IPagService } from 'src/payment-gateway/ipag.service';
import { CardService } from 'src/card/card.service';
import { CardDto } from 'src/card/dto/card.dto';
import { GenReceiptService, ReceiptTemplateData } from 'src/gen-receipt/gen.receipt.service';
import { MessageMedia } from 'whatsapp-web.js';
import { WhatsAppApiService } from 'src/shared/whatsapp-api/whatsapp.api.service';
import { Cron } from '@nestjs/schedule';

export interface RequestStructure {
    from: string;
    type: "image" | "text" | "vcard" | "document";
    content: string;
    buttonInteraction?: {
        buttonId: string;
        buttonText: string;
    };
    timestamp: number;
}

export interface ResponseStructure {
    type: "image" | "text" | "document" | "interactive";
    content: string;
    caption: string;
    to: string;
    reply: boolean;
    isCopyButton?: boolean;
}

export interface InteractiveButton {
    id: string;
    title: string;
}

export interface InteractiveMessage {
    headerType?: "text" | "image" | "document" | "video";
    headerContent?: string; // Text content or media ID/URL
    bodyText: string;
    footerText?: string;
    buttons: InteractiveButton[];
}

export interface ResponseStructureExtended extends ResponseStructure {
    isError: boolean;
    interactive?: InteractiveMessage;
}

export interface RequestMessage {
    from: string;
    body: string;
    timestamp: number;
    type: string;
}

interface retryRequestResponse {
    sentMessages: ResponseStructureExtended[];
    response: any;
}

@Injectable()
export class MessageService {
    private readonly logger = new Logger(MessageService.name);
    private readonly mongoClient: MongoClient;
    private readonly environment = process.env.ENVIRONMENT;

    private readonly waiterGroupId = process.env.ENVIRONMENT === 'homologation' || process.env.ENVIRONMENT === 'demo' ? process.env.WAITER_HOM_GROUP_ID : process.env.ENVIRONMENT === 'production' ? process.env.WAITER_PROD_GROUP_ID : process.env.WAITER_DEV_GROUP_ID;
    private readonly paymentProofGroupId = process.env.ENVIRONMENT === 'homologation' || process.env.ENVIRONMENT === 'demo' ? process.env.PAYMENT_PROOF_HOM_GROUP_ID : process.env.ENVIRONMENT === 'production' ? process.env.PAYMENT_PROOF_PROD_GROUP_ID : process.env.PAYMENT_PROOF_DEV_GROUP_ID;
    private readonly refundGroupId = process.env.ENVIRONMENT === 'homologation' || process.env.ENVIRONMENT === 'demo' ? process.env.REFUND_HOM_GROUP_ID : process.env.ENVIRONMENT === 'production' ? process.env.REFUND_PROD_GROUP_ID : process.env.REFUND_DEV_GROUP_ID;

    constructor(
        private readonly tableService: TableService,
        private readonly userService: UserService,
        private readonly conversationService: ConversationService,
        private readonly orderService: OrderService,
        private readonly transactionService: TransactionService,
        private readonly utilsService: MessageUtils,
        @Inject(forwardRef(() => IPagService)) private readonly ipagService: IPagService,
        private readonly cardService: CardService,
        private readonly genReceiptService: GenReceiptService,
        private readonly whatsappApi: WhatsAppApiService,
        @Inject('DATABASE_CONNECTION') private db: Db, clientProvider: ClientProvider
    ) {
        this.mongoClient = clientProvider.getClient();
    }

    @Cron('10 * * * * *') // a cada 10 segundos
    public async handleExpiredPIXTransactions(): Promise<void> {
        const transactions = await this.transactionService.getExpiredPIXTransactions();

        for (const transaction of transactions.data) {
            const conversation = await this.conversationService.getConversation(transaction.conversationId);

            if (!conversation.data) {
                // this.logger.error(`[handleExpiredPIXTransactions] Conversation not found for transaction ${transaction._id}`);
                continue;
            }

            const sentMessages: ResponseStructureExtended[] = [];

            sentMessages.push({
                type: "text",
                content: "*👋 Astra Pay* - Seu PIX expirou 😭",
                caption: "",
                to: conversation.data.userId,
                reply: false,
                isError: false,
            });

            sentMessages.push({
                type: "text",
                content: "O que acha de gerarmos um novo para você?\n\n1 - Sim\n2 - Não",
                caption: "",
                to: conversation.data.userId,
                reply: false,
                isError: false,
            });

            await this.conversationService.updateConversation(
                conversation.data._id.toString(),
                {
                    userId: conversation.data.userId,
                    conversationContext: {
                        ...conversation.data.conversationContext,
                        currentStep: ConversationStep.PixExpired,
                    },
                }
            );

            await this.transactionService.updateTransaction(
                transaction._id.toString(),
                { status: PaymentStatus.Expired }
            );
            await this.sendMessagesDirectly(sentMessages);
        }
    }

    @Cron('10 * * * * *') // executa a cada 10 segundos
    public async handlePendingPaymentsReminder(): Promise<void> {
        try {
            const { data: staleTransactions } = await this.transactionService.getPendingTransactionsOlderThan(
                10,
                3,
                [PaymentStatus.Pending, PaymentStatus.Waiting, PaymentStatus.Created]
            );

            for (const transaction of staleTransactions) {
                if (transaction.reminderSentAt) {
                    continue;
                }

                const conversationResp = await this.conversationService.getConversation(transaction.conversationId);
                const conversation = conversationResp.data;

                if (!conversation) {
                    // this.logger.warn(
                    // `[handlePendingPaymentsReminder] Conversation not found for transaction ${transaction._id}`
                    // );
                    continue;
                }

                const sentMessages: ResponseStructureExtended[] = [
                    {
                        type: 'text',
                        content: `*👋 Astra Pay* - Seu pagamento da comanda *${conversation.tableId}* ainda não foi finalizado.`,
                        caption: '',
                        to: conversation.userId,
                        reply: false,
                        isError: false,
                    },
                    {
                        type: 'text',
                        content: 'Ocorreu algum problema com o pagamento? Poderia nos contar mais sobre o que aconteceu?',
                        caption: '',
                        to: conversation.userId,
                        reply: false,
                        isError: false,
                    },
                ];

                await this.sendMessagesDirectly(sentMessages);

                await this.transactionService.updateTransaction(transaction._id.toString(), {
                    reminderSentAt: new Date(),
                });

                await this.conversationService.updateConversation(transaction.conversationId, {
                    userId: conversation.userId,
                    conversationContext: {
                        ...conversation.conversationContext,
                        currentStep: ConversationStep.DelayedPayment,
                        delayedReminderSentAt: new Date(),
                    },
                });
            }
        } catch (error) {
            this.logger.error(`[handlePendingPaymentsReminder] Error: ${error.message}`, error.stack);
        }
    }

    @Cron('10 * * * * *') // executa a cada 10 segundos
    public async handleUserInactivityCheck(): Promise<void> {
        try {
            const activeConversationsResponse = await this.conversationService.getAllActiveConversations();
            const activeConversations = activeConversationsResponse.data || [];

            // this.logger.debug(`[handleUserInactivityCheck] Active conversations: ${activeConversations.length}`);

            for (const conversation of activeConversations) {
                const { currentStep, lastMessage, reminderSentAt } = conversation.conversationContext;
                if (!lastMessage) {
                    continue;
                }

                const now = Date.now();
                const lastMessageTime = new Date(lastMessage).getTime();
                const diffInMinutes = Math.floor((now - lastMessageTime) / (1000 * 60));

                // this.logger.debug(`[handleUserInactivityCheck] Conversation ID: ${conversation._id}, Time difference: ${diffInMinutes} minutes`);

                if (ConversationStep.UserAbandoned === currentStep) {
                    continue;
                }

                if (diffInMinutes >= 30) {
                    const messages = [
                        '*👋 Astra Pay* - Tudo bem por aí?',
                        'Percebemos que você não concluiu o pagamento.',
                        'Poderia nos dizer o que aconteceu?'
                    ];

                    const sentMessages = this.mapTextMessages(messages, conversation.userId);

                    await this.conversationService.updateConversation(conversation._id.toString(), {
                        userId: conversation.userId,
                        conversationContext: {
                            ...conversation.conversationContext,
                            currentStep: ConversationStep.UserAbandoned,
                        },
                    });

                    await this.sendMessagesDirectly(sentMessages);
                    continue;
                }

                const stepsWithoutInactivityCheck = [
                    ConversationStep.WaitingForPayment,
                    ConversationStep.PaymentMethodSelection,
                    ConversationStep.Feedback,
                    ConversationStep.FeedbackDetail,
                    ConversationStep.Completed,
                    ConversationStep.UserAbandoned,
                ];

                if (stepsWithoutInactivityCheck.includes(currentStep)) {
                    continue;
                }

                if (diffInMinutes >= 5 && !reminderSentAt) {
                    const reminderMessage = this.getStepReminderMessage(conversation.conversationContext.currentStep);
                    const reminderMessages = this.mapTextMessages(
                        [
                            '*👋 Astra Pay* - Está tudo bem?',
                            reminderMessage,
                        ],
                        conversation.userId
                    );

                    const updatedContext: ConversationContextDTO = {
                        ...conversation.conversationContext,
                        reminderSentAt: new Date(),
                    };
                    await this.conversationService.updateConversation(conversation._id.toString(), {
                        userId: conversation.userId,
                        conversationContext: updatedContext,
                    });

                    await this.sendMessagesDirectly(reminderMessages);
                }
            }

        } catch (error) {
            this.logger.error(`[handleUserInactivityCheck] Error: ${error.message}`, error.stack);
        }
    }

    public async handleProcessMessage(request: RequestStructure): Promise<ResponseStructureExtended[]> {
        const fromPerson = request.from;

        const message: RequestMessage = {
            from: fromPerson,
            body: request.content,
            timestamp: request.timestamp,
            type: request.type,
        };

        // Calculate message age to avoid processing old messages
        const currentTime = Math.floor(Date.now() / 1000);
        const messageAge = currentTime - message.timestamp;
        const maxAllowedAge = 30; // 30 seconds

        if (messageAge > maxAllowedAge) {
            this.logger.debug(`Ignoring old message from ${message.from}: ${message.body}`);
            return [];
        }

        const from = message.from;

        // Garante que usuário e conversa existam
        await this.handleIncomingMessage(from);

        // Recupera a conversa ativa
        const activeConversationResponse = await this.conversationService.getActiveConversation(from);
        let state = activeConversationResponse.data;

        this.logger.debug(`[handleProcessMessage] Request type: ${request.type}`);
        if (request.type === 'image' || request.type === 'document') {
            this.logger.debug(`[handleProcessMessage] Image or document received from ${from}`);
            if (!state) {
                return [
                    {
                        type: "text",
                        content: "Desculpe, não entendi sua solicitação. Se você gostaria de pagar uma comanda, por favor, use a frase 'Gostaria de pagar a comanda X'.",
                        caption: "",
                        to: from,
                        reply: true,
                        isError: false
                    }
                ];
            }

            const currentStep = state.conversationContext.currentStep;

            if (currentStep === ConversationStep.WaitingForPayment || currentStep === ConversationStep.EmptyOrder) {
                return [];
            }

            if (
                currentStep === ConversationStep.Feedback ||
                currentStep === ConversationStep.FeedbackDetail
            ) {
                // Mensagem imediata de acknowledgment
                const immediateReply: ResponseStructureExtended = {
                    type: "text",
                    content: "Comprovante recebido!",
                    caption: "",
                    to: from,
                    reply: true,
                    isError: false
                };

                let feedbackReplication: ResponseStructureExtended[] = [];
                if (currentStep === ConversationStep.Feedback) {
                    const feedbackOptionsMessage = this.whatsappApi.createInteractiveButtonMessage(
                        from,
                        "Por favor, avalie como foi sua experiência conosco:",
                        [
                            { id: "feedback_1", title: "Muito decepcionado" },
                            { id: "feedback_2", title: "Pouco decepcionado" },
                            { id: "feedback_3", title: "Não faria diferença" }
                        ],
                        {
                            headerType: "text",
                            headerContent: "Sua opinião é importante",
                            footerText: "Ajude-nos a melhorar"
                        }
                    );
                    feedbackReplication = [feedbackOptionsMessage];
                } else {
                    const feedback = state.conversationContext.feedback;
                    if (!feedback?.mustHaveScore) {
                        feedbackReplication = this.mapTextMessages(
                            ["Pode nos contar um pouco mais sobre o motivo da sua escolha?"],
                            from,
                            false
                        );
                    } else {
                        if (
                            feedback.mustHaveScore === 'Muito decepcionado' ||
                            feedback.mustHaveScore === 'Um pouco decepcionado'
                        ) {
                            feedbackReplication = this.mapTextMessages(
                                [
                                    "Em quais outros restaurantes você gostaria de pagar na mesa com a Astra? ✨"
                                ],
                                from,
                                false
                            );
                        } else {
                            feedbackReplication = this.mapTextMessages(
                                [
                                    "Obrigado pelo feedback! Se precisar de algo mais, estamos aqui."
                                ],
                                from,
                                false
                            );
                        }
                    }
                }

                return [immediateReply, ...feedbackReplication];
            }

            return [
                {
                    type: "text",
                    content: "Comprovante recebido! Qualquer dúvida, estamos à disposição.",
                    caption: "",
                    to: from,
                    reply: true,
                    isError: false,
                }
            ];
        }

        const userMessage = message.body.trim().toLowerCase();

        const terminalStates = [
            ConversationStep.Completed,
            ConversationStep.IncompleteOrder,
            ConversationStep.OrderNotFound,
            ConversationStep.PaymentInvalid,
            ConversationStep.PaymentAssistance,
            ConversationStep.EmptyOrder,
            ConversationStep.PIXError
        ];
        if (
            (!state || (state && terminalStates.includes(state.conversationContext.currentStep))) &&
            userMessage.includes('pagar a comanda')
        ) {
            const newConversation: CreateConversationDto = {
                userId: from,
                conversationContext: {
                    currentStep: ConversationStep.Initial,
                    messages: [],
                    lastMessage: new Date(),
                },
            };
            const createdConversationResponse = await this.conversationService.createConversation(newConversation);
            const newConversationId = await this.conversationService.getConversation(createdConversationResponse.data._id);
            state = newConversationId.data;
        }

        if (!state) {
            this.logger.debug(`No active conversation for user ${from}`);
            return [
                {
                    type: "text",
                    content: "Desculpe, não entendi sua solicitação. Se você gostaria de pagar uma comanda, por favor, use a frase 'Gostaria de pagar a comanda X'.",
                    caption: "",
                    to: from,
                    reply: true,
                    isError: false,
                }
            ];
        }

        let requestResponse: ResponseStructureExtended[] = [];

        switch (state.conversationContext.currentStep) {
            case ConversationStep.ProcessingOrder:
                if (userMessage.includes('pagar a comanda')) {
                    state.conversationContext.currentStep = ConversationStep.Initial;
                    requestResponse = await this.handleOrderProcessing(from, userMessage, state, message);
                }
                break;
            case ConversationStep.ConfirmOrder:
                if (userMessage.includes('pagar a comanda')) {
                    state.conversationContext.currentStep = ConversationStep.Initial;
                    requestResponse = await this.handleOrderProcessing(from, userMessage, state, message);
                } else {
                    requestResponse = await this.handleConfirmOrder(from, userMessage, state);
                }
                break;
            /*
            // Se você reativar a lógica de "dividir conta", deixá-la aqui
            case ConversationStep.SplitBill:
                requestResponse = await this.handleSplitBill(from, userMessage, state);
                break;
            case ConversationStep.SplitBillNumber:
                requestResponse = await this.handleSplitBillNumber(from, userMessage, state);
                break;
            case ConversationStep.WaitingForContacts:
                requestResponse = await this.handleWaitingForContacts(from, state, message);
                break;
            */
            case ConversationStep.ExtraTip:
                requestResponse = await this.handleExtraTip(from, userMessage, state);
                break;
            case ConversationStep.CollectCPF:
                requestResponse = await this.handleCollectCPF(from, userMessage, state);
                break;
            // case ConversationStep.PaymentMethodSelection:
            //     requestResponse = await this.handlePaymentMethodSelection(from, userMessage, state);
            //     break;
            // case ConversationStep.SelectSavedCard:
            // requestResponse = await this.handleSelectSavedCard(from, userMessage, state);
            // break;
            case ConversationStep.WaitingForPayment:
                requestResponse = await this.handleWaitingForPayment(from, userMessage, state)
                break;
            case ConversationStep.PixExpired:
                requestResponse = await this.handlePixExpired(from, userMessage, state);
                break;
            case ConversationStep.CollectName:
                requestResponse = await this.handleCollectName(from, userMessage, state);
                break;
            case ConversationStep.PIXError:
                requestResponse = await this.handlePIXError(from, userMessage, state);
                break;
            case ConversationStep.Feedback:
                requestResponse = await this.handleFeedback(from, userMessage, state);
                break;
            case ConversationStep.FeedbackDetail:
                requestResponse = await this.handleFeedbackDetail(from, userMessage, state);
                break;
            case ConversationStep.DelayedPayment:
                requestResponse = await this.handleDelayedPayment(from, userMessage, state);
                break;
            case ConversationStep.UserAbandoned:
                requestResponse = await this.handleUserAbandoned(from, userMessage, state);
                break;
            case ConversationStep.Completed:
                // Se a conversa estiver finalizada mas a mensagem não contiver a frase para iniciar nova conversa,
                // pode-se enviar uma resposta padrão.
                requestResponse.push({
                    type: "text",
                    content: "Sua última conversa foi finalizada. Se deseja pagar outra comanda, envie 'pagar a comanda X'.",
                    caption: "",
                    to: from,
                    reply: true,
                    isError: false,
                });
                break;

            default:
                if (userMessage.includes('pagar a comanda')) {
                    requestResponse = await this.handleOrderProcessing(from, userMessage, state, message);
                } else {
                    this.logger.debug(`No action for user ${from}: ${userMessage}`);
                    requestResponse.push({
                        type: "text",
                        content: "Desculpe, não entendi sua solicitação. Se você gostaria de pagar uma comanda, por favor, use a frase 'Gostaria de pagar a comanda X'.",
                        caption: "",
                        to: from,
                        reply: true,
                        isError: false,
                    });
                }
                break;
        }

        return requestResponse;
    }




    /**
     * Handles the incoming message, ensuring the user and conversation are registered in the database,
     * and adds the message to the conversation history.
     *
     * @param userId - The unique identifier of the user sending the message.
     * @param message - The received message object.
     */

    private async handleIncomingMessage(userId: string): Promise<void> {
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

        // const activeConversationResponse = await this.conversationService
        //     .getActiveConversation(userId)
        //     .catch(() => null);

        // if (!activeConversationResponse?.data) {
        //     const newConversation: CreateConversationDto = {
        //         userId,
        //         conversationContext: {
        //             currentStep: ConversationStep.Initial,
        //             messages: [],
        //             lastMessage: new Date(),
        //         },
        //     };
        //     await this.conversationService.createConversation(newConversation);
        // }
    }

    private async handleOrderProcessing(
        from: string,
        userMessage: string,
        state: ConversationDto,
        message: RequestMessage,
    ): Promise<ResponseStructureExtended[]> {
        const sentMessages: ResponseStructureExtended[] = [];
        const tableId = this.extractOrderId(userMessage);

        if (!tableId) {
            sentMessages.push(
                ...this.mapTextMessages(
                    [
                        'Desculpe, não entendi o número da comanda. Por favor, diga "Gostaria de pagar a comanda X", onde X é o número da comanda.',
                    ],
                    from,
                    true,
                ),
            );
            return sentMessages;
        }

        const tableIdInt = parseInt(tableId, 10);
        const orderProcessingInfo = await this.isOrderBeingProcessed(tableId, from);

        // Se ninguém está processando a comanda, inicie o processamento.
        if (!orderProcessingInfo.isProcessing) {
            // Atualiza o contexto para ProcessingOrder.
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

            sentMessages.push(
                ...this.mapTextMessages(
                    [
                        '*👋 Astra Pay* – Bem-vindo(a)!\n' +
                        'Tornamos o seu pagamento prático e sem complicações.\n\n' +
                        '*Forma de Pagamento Aceita:*\n' +
                        '1. PIX\n\n' +
                        // Removed Credit Card option
                        '> Ao continuar você concorda com nossa Política de Privacidade: https://astra1.com.br/privacy-policy/'
                    ],
                    from,
                    true,
                ),
            );

            // Processa a comanda (chamada para a função de processamento interno).
            const processingMessages = await this.handleProcessingOrder(from, state, tableIdInt);
            sentMessages.push(...processingMessages);

            return sentMessages;
        }

        // Se a comanda já está sendo processada, verifique a inatividade do outro usuário.
        const { state: otherState, userNumber } = orderProcessingInfo;
        const lastMessageTime = otherState?.conversationContext?.lastMessage
            ? new Date(otherState.conversationContext.lastMessage).getTime()
            : 0;
        const timeSinceLastMessage = (Date.now() - lastMessageTime) / (1000 * 60);
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
                this.logger.warn(`Unable to mark conversation as errored for user ${userNumber}: Missing conversation ID.`);
            }

            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: {
                    ...state.conversationContext,
                    currentStep: ConversationStep.ProcessingOrder,
                },
            });

            sentMessages.push(
                ...this.mapTextMessages(
                    [
                        '*👋 Astra Pay* – Bem-vindo(a)!\nTornamos o seu pagamento prático e sem complicações.\n\n*Formas de Pagamento Aceitas:*\n1. PIX\n2. Cartão de Crédito\n\n_Em caso de dúvidas sobre privacidade ou solicitação de remoção dos seus dados, entre em contato pelo e-mail:_ \nsuporte@astra1.com.br',
                    ],
                    from,
                    true,
                ),
            );

            const processingMessages = await this.handleProcessingOrder(from, state, tableIdInt);
            sentMessages.push(...processingMessages);

            return sentMessages;
        }

        // Se outra pessoa já está processando a comanda e não está inativa
        sentMessages.push(
            ...this.mapTextMessages(
                ['Desculpe, esta comanda já está sendo processada por outra pessoa.'],
                from,
                true,
            ),
        );

        return sentMessages;
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
    ): Promise<ResponseStructureExtended[]> {
        const sentMessages: ResponseStructureExtended[] = [];
        const conversationId = state._id.toString();

        try {
            // Obtém os dados do pedido
            const retryResponse = await this.retryRequestWithNotification({
                from,
                requestFunction: () => this.tableService.orderMessage(tableId),
                state,
            });

            this.logger.log(`[handleProcessingOrder] Retry response: ${JSON.stringify(retryResponse.response)}`);

            if (!retryResponse.response) {
                this.logger.error(`[handleProcessingOrder] Error getting order details for table ${tableId}. User: ${from}`);

                if (retryResponse.sentMessages) {
                    sentMessages.push(...retryResponse.sentMessages);
                }

                return sentMessages;
            } else if (
                !retryResponse.response.details ||
                Object.keys(retryResponse.response.details).length === 0
            ) {
                this.logger.error(`[handleProcessingOrder] No content found for table ${tableId}. User: ${from}`);
                sentMessages.push(
                    ...this.mapTextMessages(
                        ['*👋 Astra Pay* - Não há pedidos cadastrados em sua comanda. Por favor, tente novamente mais tarde.'],
                        from,
                        true,
                        false,
                        true,
                    ),
                );

                await this.conversationService.updateConversationWithErrorStatus(
                    conversationId,
                    ConversationStep.EmptyOrder,
                );

                return sentMessages;
            }


            const orderData = retryResponse.response;

            const orderMessage = orderData.message;
            const orderDetails = orderData.details;

            // Adiciona a mensagem do pedido como texto
            sentMessages.push(
                ...this.mapTextMessages(
                    [orderMessage],
                    from,
                ),
            );

            // Adiciona a pergunta de confirmação como botões interativos
            const confirmationMessage = this.whatsappApi.createInteractiveButtonMessage(
                from,
                "👍 A sua comanda está correta?",
                [
                    { id: "confirm_yes", title: "Sim" },
                    { id: "confirm_no", title: "Não" }
                ],
                {
                    headerType: "text",
                    headerContent: "Confirmação do Pedido",
                    footerText: ""
                }
            );

            sentMessages.push(confirmationMessage);

            // Cria a ordem do pedido
            const createOrderData: CreateOrderDTO = {
                tableId,
                items: orderDetails.orders,
                totalAmount: this.formatToTwoDecimalPlaces(orderDetails.total),
                appliedDiscount: orderDetails.discount,
                amountPaidSoFar: 0,
            };

            const createdOrderData = await this.orderService.createOrder(createOrderData);

            // Atualiza a conversa com os novos dados
            const updateConversationData: BaseConversationDto = {
                userId: state.userId,
                tableId: tableId.toString(),
                orderId: createdOrderData.data._id.toString(),
                conversationContext: {
                    ...state.conversationContext,
                    currentStep: ConversationStep.ConfirmOrder,
                    totalOrderAmount: orderDetails.total,
                },
            };

            await this.conversationService.updateConversation(conversationId, updateConversationData);
        } catch (error) {
            await this.conversationService.updateConversationWithErrorStatus(
                conversationId,
                ConversationStep.OrderNotFound,
            );
        }

        return sentMessages;
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

    private mapTextMessages(
        messages: string[],
        to: string,
        reply: boolean = false,
        toGroup: boolean = false,
        isError: boolean = false
    ): ResponseStructureExtended[] {
        return messages.map((message, index) => {
            const content = toGroup
                ? `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\n${message}`
                : message;

            const isFirst = index === 0;
            const replyFlag = isFirst ? reply : false;

            return {
                type: 'text',
                content,
                caption: '',
                to,
                reply: replyFlag,
                isError,
            };
        });
    }



    private async handleConfirmOrder(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<ResponseStructureExtended[]> {
        const sentMessages: ResponseStructureExtended[] = [];
        const positiveResponses = ['1', 'sim', 'correta', 'está correta', 'sim está correta', 'button_confirm_yes'];
        const negativeResponses = ['2', 'não', 'nao', 'não está correta', 'incorreta', 'não correta', 'button_confirm_no'];

        const updatedContext: ConversationContextDTO = { ...state.conversationContext };
        const tableId = parseInt(state.tableId, 10);

        // Check if the response is from a button interaction
        const isButtonResponse = userMessage.startsWith('button_');

        // For button responses, we need to check if it starts with the button_ID prefix
        const isPositiveResponse = isButtonResponse
            ? userMessage.startsWith('button_confirm_yes:')
            : positiveResponses.some((response) => userMessage.toLowerCase().includes(response));

        const isNegativeResponse = isButtonResponse
            ? userMessage.startsWith('button_confirm_no:')
            : negativeResponses.some((response) => userMessage.toLowerCase().includes(response));

        if (isPositiveResponse) {
            if (!updatedContext.userAmount || updatedContext.userAmount <= 0) {
                updatedContext.userAmount = updatedContext.totalOrderAmount;
            }


            const notifyWaiterMessages = this.notifyWaiterTableStartedPayment(tableId);

            // Replace text message with interactive buttons for tip selection
            const tipSelectionMessage = this.whatsappApi.createInteractiveButtonMessage(
                from,
                "Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸",
                [
                    { id: "tip_3", title: "3%" },
                    { id: "tip_5", title: "5% 🔥" },
                    { id: "tip_7", title: "7%" }
                ],
                {
                    headerType: "text",
                    headerContent: "Gorjeta",
                    footerText: "Escolha das últimas mesas: 5% 🔥"
                }
            );

            sentMessages.push(tipSelectionMessage);

            this.retryRequestWithNotification({
                from,
                requestFunction: () => this.tableService.startPayment(tableId),
                state,
                sendDelayNotification: false,
                groupMessage: GroupMessages[GroupMessageKeys.PREBILL_ERROR](state.tableId),
            });

            updatedContext.currentStep = ConversationStep.ExtraTip;

        } else if (isNegativeResponse) {
            sentMessages.push(
                ...this.mapTextMessages(
                    [
                        'Que pena! Lamentamos pelo ocorrido e o atendente responsável irá conversar com você.',
                    ],
                    from,
                ),
            );

            const notifyWaiterMessages = this.notifyWaiterWrongOrder(tableId);
            sentMessages.push(...notifyWaiterMessages);

            updatedContext.currentStep = ConversationStep.IncompleteOrder;
        } else {
            // Replace text message with interactive buttons for confirmation
            const confirmationMessage = this.whatsappApi.createInteractiveButtonMessage(
                from,
                "👍 A sua comanda está correta?",
                [
                    { id: "confirm_yes", title: "Sim" },
                    { id: "confirm_no", title: "Não" }
                ],
                {
                    headerType: "text",
                    headerContent: "Confirmação do Pedido",
                    footerText: ""
                }
            );

            sentMessages.push(confirmationMessage);
        }

        // Atualiza o contexto da conversa no banco
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
    ): Promise<ResponseStructureExtended[]> {
        const sentMessages: ResponseStructureExtended[] = [];

        // Ajuste na lógica: Agora 2 = Sim (Dividir) e 1 = Não (Não dividir)
        const positiveResponses = ['2', 'sim', 'quero dividir', 'dividir', 'sim dividir', 'partes iguais'];
        const negativeResponses = ['1', 'não', 'nao', 'não quero dividir', 'não dividir'];

        if (negativeResponses.some((response) => userMessage.includes(response))) {
            // Agora "1" significa "Não quero dividir"
            sentMessages.push(
                ...this.mapTextMessages(
                    [
                        'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
                    ],
                    from,
                ),
            );

            const updatedContext: ConversationContextDTO = {
                ...state.conversationContext,
                currentStep: ConversationStep.ExtraTip,
                userAmount: this.calculateUserAmount(state),
            };

            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: updatedContext,
            });

        } else if (positiveResponses.some((response) => userMessage.includes(response))) {
            // Agora "2" significa "Sim, quero dividir"
            sentMessages.push(
                ...this.mapTextMessages(
                    [
                        'Com quantas pessoas, *incluindo você*, a conta será dividida?\n\nLembrando que a divisão será feita em *partes iguais* entre todos.',
                    ],
                    from,
                ),
            );

            const updatedContext: ConversationContextDTO = {
                ...state.conversationContext,
                currentStep: ConversationStep.SplitBillNumber,
            };

            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: updatedContext,
            });

        } else {
            // Caso a resposta seja inválida
            sentMessages.push(
                ...this.mapTextMessages(
                    ['Por favor, responda com *2 para Sim* ou *1 para Não*.'],
                    from,
                ),
            );
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
    ): Promise<ResponseStructureExtended[]> {
        const sentMessages: ResponseStructureExtended[] = [];

        const numPeopleMatch = userMessage.match(/\d+/);
        const numPeople = numPeopleMatch ? parseInt(numPeopleMatch[0]) : NaN;

        if (!isNaN(numPeople) && numPeople > 1) {
            const splitInfo: SplitInfoDTO = {
                numberOfPeople: numPeople,
                participants: [],
            };

            const updatedContext: ConversationContextDTO = {
                ...state.conversationContext,
                splitInfo: splitInfo,
                currentStep: ConversationStep.WaitingForContacts,
            };

            sentMessages.push(
                ...this.mapTextMessages(
                    [
                        '😊 Perfeito! Me envie os contatos das pessoas usando o botão *Enviar Contato do WhatsApp*.\n\nAssim que recebermos, seguimos com o atendimento! 📲'
                    ],
                    from,
                ),
            );

            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: updatedContext,
            });

            await this.orderService.updateOrder(state.orderId, {
                splitInfo: splitInfo,
            });
        } else {
            sentMessages.push(
                ...this.mapTextMessages(
                    ['Por favor, informe um número válido de pessoas (maior que 1).'],
                    from,
                ),
            );
        }

        return sentMessages;
    }


    private async handleWaitingForContacts(
        from: string,
        state: ConversationDto,
        message: RequestMessage
    ): Promise<ResponseStructureExtended[]> {
        let sentMessages: ResponseStructureExtended[] = [];

        if (this.utilsService.isVcardMessage(message)) {
            try {
                const {
                    contactsNeeded,
                    remainingContactsNeeded,
                    totalContactsExpected,
                } = this.utilsService.calculateContactsNeeded(state);

                if (remainingContactsNeeded <= 0) {
                    sentMessages = await this.handleAllContactsAlreadyReceived(from, state);
                    return sentMessages;
                }

                const extractedContacts = this.utilsService.extractContactsFromVcards(message, remainingContactsNeeded);
                this.utilsService.addExtractedContactsToState(state, extractedContacts);

                const responseMessage = this.buildContactsReceivedMessage(
                    extractedContacts,
                    extractedContacts.length,
                    remainingContactsNeeded,
                    totalContactsExpected,
                    state
                );

                sentMessages.push(...this.mapTextMessages([responseMessage], from));

                if (this.utilsService.haveAllContacts(state, totalContactsExpected)) {
                    const finalMessages = await this.finalizeContactsReception(from, state);
                    sentMessages.push(...finalMessages);
                }
            } catch (error) {
                const errorMessages = await this.handleVcardProcessingError(from, state, error);
                sentMessages.push(...errorMessages);
            }
        } else {
            sentMessages = await this.promptForContact(from, state);
        }

        return sentMessages;
    }



    private async handleAllContactsAlreadyReceived(
        from: string,
        state: ConversationDto,
    ): Promise<ResponseStructureExtended[]> {
        const sentMessages: ResponseStructureExtended[] = [];
        const messages = [
            'Você já enviou todos os contatos necessários.',
            'Vamos prosseguir com seu atendimento. 😄',
        ];

        sentMessages.push(
            ...this.mapTextMessages(messages, from),
        );

        const updatedContext: ConversationContextDTO = {
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
        contacts: ParticipantDTO[],
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

        const totalContactsReceived = state.conversationContext.splitInfo.participants.length;
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
        state: ConversationDto
    ): Promise<ResponseStructureExtended[]> {
        let sentMessages: ResponseStructureExtended[] = [];
        const { data: orderData } = await this.orderService.getOrder(state.orderId);
        const totalAmount = orderData.totalAmount;
        const numPeople = state.conversationContext.splitInfo.numberOfPeople;
        const individualAmount = this.formatToTwoDecimalPlaces(totalAmount / numPeople);

        await this.updateConversationAndCreateTransaction(state, individualAmount, totalAmount);

        const notificationMessages = await this.notifyIncludedContacts(state, totalAmount, individualAmount);
        sentMessages.push(...notificationMessages);

        sentMessages.push(
            ...this.mapTextMessages(
                [
                    'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
                ],
                from
            )
        );

        return sentMessages;
    }


    private async updateConversationAndCreateTransaction(
        state: ConversationDto,
        individualAmount: number,
        totalAmount: number,
    ): Promise<void> {
        const contacts = state.conversationContext.splitInfo.participants.map((contact) => ({
            ...contact,
            expectedAmount: individualAmount,
        }));

        // add the contact of the user itself
        contacts.push({
            name: state.userId,
            phone: state.userId.includes('@s.whatsapp.net') ? state.userId : state.userId + '@s.whatsapp.net',
            expectedAmount: individualAmount,
            paidAmount: 0,
        });

        const splitInfo: SplitInfoDTO = {
            numberOfPeople: state.conversationContext.splitInfo.numberOfPeople,
            participants: contacts.map((contact) => ({
                name: contact.name.includes('@s.whatsapp.net') ? 'Cliente' : contact.name,
                phone: contact.phone.includes('@s.whatsapp.net') ? contact.phone : contact.phone + '@s.whatsapp.net',
                expectedAmount: contact.expectedAmount,
                paidAmount: 0,
            }))
        }

        const updatedConversationData: ConversationContextDTO = {
            ...state.conversationContext,
            splitInfo: splitInfo,
            currentStep: ConversationStep.ExtraTip,
            userAmount: individualAmount,
        };



        await this.conversationService.updateConversation(state._id.toString(), {
            userId: state.userId,
            conversationContext: updatedConversationData,
        });

        await this.orderService.updateOrder(state.orderId, {
            splitInfo: splitInfo,
        });
    }

    private async notifyIncludedContacts(
        state: ConversationDto,
        totalAmount: number,
        individualAmount: number
    ): Promise<ResponseStructureExtended[]> {
        const sentMessages: ResponseStructureExtended[] = [];
        const contacts = state.conversationContext.splitInfo.participants;

        for (const contact of contacts) {
            const contactId = `${contact.phone}@s.whatsapp.net`;
            const messages = [
                `*👋 Astra Pay* - Olá! Você foi incluído na divisão do pagamento da comanda *${state.tableId}* no restaurante Cris Parrilla.`,
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

            sentMessages.push(
                ...this.mapTextMessages(messages, contactId),
            );
        }

        return sentMessages;
    }


    private async handleVcardProcessingError(
        from: string,
        state: ConversationDto,
        error: any
    ): Promise<ResponseStructureExtended[]> {
        this.logger.error('Erro ao processar o(s) vCard(s):', error);

        const errorMessages = [
            '❌ Ocorreu um erro ao processar o contato. Por favor, tente novamente enviando o contato.',
        ];

        return this.mapTextMessages(errorMessages, from);
    }

    private async promptForContact(
        from: string,
        state: ConversationDto
    ): Promise<ResponseStructureExtended[]> {
        const promptMessages = [
            '📲 Por favor, envie o contato da pessoa com quem deseja dividir a conta.',
        ];

        return this.mapTextMessages(promptMessages, from);
    }

    /**
     * Step 6: Extra Tip
     *
     * Agora, em vez de enviar diretamente a chave PIX e ir para o WaitingForPayment,
     * o usuário será direcionado para a coleta do CPF (CollectCPF).
     */
    // 1. handleExtraTip – REMOÇÃO DA CRIAÇÃO DA TRANSAÇÃO
    private async handleExtraTip(
        from: string,
        userMessage: string,
        state: ConversationDto
    ): Promise<ResponseStructureExtended[]> {
        let sentMessages: ResponseStructureExtended[] = [];
        const noTipKeywords = ['não', 'nao', 'n quero', 'não quero', 'nao quero'];

        // Handle button responses for tips
        if (userMessage.startsWith('button_tip_')) {
            // Extract the percentage from the button ID (e.g., "button_tip_3:3%" -> 3)
            const match = userMessage.match(/button_tip_(\d+):/);
            if (match && match[1]) {
                const tipPercent = parseInt(match[1], 10);
                return await this.handleTipAmount(from, state, tipPercent);
            }
        }

        const tipPercent = parseFloat(userMessage.replace('%', '').replace(',', '.'));

        if (this.isNoTip(userMessage, noTipKeywords) || tipPercent === 0) {
            sentMessages = await this.handleNoTip(from, state);
        } else if (tipPercent > 0) {
            sentMessages = await this.handleTipAmount(from, state, tipPercent);
        } else {
            sentMessages = await this.handleInvalidTip(from, state);
        }

        return sentMessages;
    }


    private isNoTip(userMessage: string, noTipKeywords: string[]): boolean {
        return noTipKeywords.some((keyword) => userMessage.includes(keyword));
    }

    /**
     * Subfluxo: Usuário optou por NÃO dar gorjeta.
     * Antes, enviávamos a chave PIX e mudávamos para WaitingForPayment.
     * Agora, mudamos o fluxo para CollectCPF.
     */
    private async handleNoTip(
        from: string,
        state: ConversationDto
    ): Promise<ResponseStructureExtended[]> {
        // Mensagem de confirmação de "sem problemas".
        const messages = [
            'Sem problemas!',
            'Para a emissão de sua nota fiscal\n\n*Qual o seu CPF ou CNPJ?*'
        ];

        const sentMessages = this.mapTextMessages(messages, from);

        // Atualiza o contexto para a etapa de coleta do CPF.
        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            currentStep: ConversationStep.CollectCPF,
        };

        await this.conversationService.updateConversation(state._id.toString(), {
            userId: state.userId,
            conversationContext: updatedContext,
        });

        return sentMessages;
    }

    /**
     * Subfluxo: Usuário optou por DAR gorjeta (tip).
     * Anteriormente, enviávamos a chave PIX e alterávamos para WaitingForPayment.
     * Agora, mudamos o fluxo para CollectCPF.
     */
    private async handleTipAmount(
        from: string,
        state: ConversationDto,
        tipPercent: number
    ): Promise<ResponseStructureExtended[]> {
        const sentMessages: ResponseStructureExtended[] = [];
        const userAmount = this.formatToTwoDecimalPlaces(state.conversationContext.userAmount);
        const totalAmountWithTip = this.formatToTwoDecimalPlaces(userAmount * (1 + tipPercent / 100));
        const tipResponse = this.getTipResponse(tipPercent);

        // Mantém a mensagem de agradecimento ou destaque da gorjeta
        sentMessages.push(...this.mapTextMessages([tipResponse], from));

        // Mensagem para solicitar o CPF antes do pagamento
        sentMessages.push(
            ...this.mapTextMessages(
                ['Para a emissão de sua nota fiscal\n\n*Qual o seu CPF ou CNPJ?*'],
                from
            ),
        );

        // Atualiza o contexto para coletar o CPF em seguida
        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            currentStep: ConversationStep.CollectCPF,
            userAmount: totalAmountWithTip,
            tipAmount: this.formatToTwoDecimalPlaces(totalAmountWithTip - userAmount),
            tipPercent: tipPercent,
        };

        await this.conversationService.updateConversation(state._id.toString(), {
            userId: state.userId,
            conversationContext: updatedContext,
        });

        // Ajusta o valor direto no estado (caso seja usado em outras partes do fluxo)
        state.conversationContext.userAmount = this.formatToTwoDecimalPlaces(totalAmountWithTip);

        return sentMessages;
    }

    private async handleInvalidTip(
        from: string,
        state: ConversationDto
    ): Promise<ResponseStructureExtended[]> {
        const sentMessages: ResponseStructureExtended[] = [];

        // Create interactive button message for tip options
        const tipOptionsMessage = this.whatsappApi.createInteractiveButtonMessage(
            from,
            "Por favor, escolha uma das opções de gorjeta:",
            [
                { id: "tip_3", title: "3%" },
                { id: "tip_5", title: "5% 🔥" },
                { id: "tip_7", title: "7%" },
                { id: "tip_0", title: "Sem gorjeta" }
            ],
            {
                headerType: "text",
                headerContent: "Opções de Gorjeta",
                footerText: "Sua contribuição é muito apreciada pela nossa equipe!"
            }
        );

        sentMessages.push(tipOptionsMessage);

        return sentMessages;
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

    private async handleCollectCPF(
        from: string,
        userMessage: string,
        state: ConversationDto
    ): Promise<ResponseStructureExtended[]> {
        let sentMessages: ResponseStructureExtended[] = [];
        const conversationId = state._id.toString();

        const documentNumber = userMessage.replace(/\D/g, '');

        let isValidDocument = false;
        let documentType = '';

        if (documentNumber.length === 11) {
            isValidDocument = this.isValidCPF(documentNumber);
            documentType = 'CPF';
        } else if (documentNumber.length === 14) {
            isValidDocument = this.isValidCNPJ(documentNumber);
            documentType = 'CNPJ';
        }

        if (!isValidDocument) {
            sentMessages = await this.handleInvalidCPF(from, state);
            return sentMessages;
        }

        // Modified: Skip payment method selection and go directly to CollectName
        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            currentStep: ConversationStep.CollectName,
            paymentMethod: PaymentMethod.PIX, // Set PIX as default payment method
            documentNumber: documentNumber,
        };

        await this.conversationService.updateConversation(conversationId, {
            userId: state.userId,
            conversationContext: updatedContext,
        });

        // Ask for name directly
        sentMessages.push(
            ...this.mapTextMessages(
                ['😊 Para continuarmos com o pagamento via PIX\n\n*Qual é o seu nome completo?*'],
                from,
            ),
        );

        return sentMessages;
    }




    /**
     * Função para lidar com CPF inválido.
     */
    private async handleInvalidCPF(from: string, state: ConversationDto): Promise<ResponseStructureExtended[]> {
        const messages = ['Por favor, informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido. 🧐'];
        return this.mapTextMessages(messages, from);
    }



    /**
     * Função para lidar com as instruções de pagamento após a coleta do CPF.
     */
    private async handlePIXPaymentInstructions(
        from: string,
        state: ConversationDto,
        pixKey?: string
    ): Promise<ResponseStructureExtended[]> {
        const finalAmount = this.formatToTwoDecimalPlaces(state.conversationContext.userAmount);
        const messages = [
            `O valor final da sua conta é: *${formatToBRL(finalAmount)}*`,
            'Segue abaixo a chave PIX para pagamento 👇',
            pixKey ? pixKey : '00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
            '*Copie a chave PIX completa*\n\nCertifique-se de copiar todos os caracteres corretamente para evitar erros no pagamento.',
        ];
        return this.mapTextMessages(messages, from);
    }



    /**
     * Valida matematicamente um CPF.
     * @param cpf - CPF limpo (apenas números)
     * @returns boolean - Retorna true se o CPF for válido, caso contrário, false.
     */
    private isValidCPF(cpf: string): boolean {
        // Elimina CPFs com todos os dígitos iguais
        if (/^(\d)\1{10}$/.test(cpf)) {
            return false;
        }

        let sum = 0;
        let remainder;

        // Validação do primeiro dígito verificador
        for (let i = 1; i <= 9; i++) {
            sum += parseInt(cpf.substring(i - 1, i)) * (11 - i);
        }
        remainder = (sum * 10) % 11;
        if (remainder === 10 || remainder === 11) {
            remainder = 0;
        }
        if (remainder !== parseInt(cpf.substring(9, 10))) {
            return false;
        }

        // Validação do segundo dígito verificador
        sum = 0;
        for (let i = 1; i <= 10; i++) {
            sum += parseInt(cpf.substring(i - 1, i)) * (12 - i);
        }
        remainder = (sum * 10) % 11;
        if (remainder === 10 || remainder === 11) {
            remainder = 0;
        }
        if (remainder !== parseInt(cpf.substring(10, 11))) {
            return false;
        }

        return true;
    }

    /**
  * Valida matematicamente um CNPJ.
  * @param cnpj - CNPJ limpo (apenas números)
  * @returns boolean - Retorna true se o CNPJ for válido, caso contrário, false.
  */
    private isValidCNPJ(cnpj: string): boolean {
        // Remove quaisquer caracteres não numéricos (garante tratamento para valores formatados ou não)
        cnpj = cnpj.replace(/[^\d]+/g, '');

        if (cnpj.length !== 14) return false;

        // Elimina CNPJs com todos os dígitos iguais
        if (/^(\d)\1+$/.test(cnpj)) return false;

        // Validação do primeiro dígito verificador
        let tamanho = cnpj.length - 2;
        let numeros = cnpj.substring(0, tamanho);
        const digitos = cnpj.substring(tamanho);
        let soma = 0;
        let pos = tamanho - 7;
        for (let i = tamanho; i >= 1; i--) {
            soma += parseInt(numeros.charAt(tamanho - i)) * pos--;
            if (pos < 2) pos = 9;
        }
        let resultado = soma % 11 < 2 ? 0 : 11 - (soma % 11);
        if (resultado !== parseInt(digitos.charAt(0))) return false;

        // Validação do segundo dígito verificador
        tamanho = tamanho + 1;
        numeros = cnpj.substring(0, tamanho);
        soma = 0;
        pos = tamanho - 7;
        for (let i = tamanho; i >= 1; i--) {
            soma += parseInt(numeros.charAt(tamanho - i)) * pos--;
            if (pos < 2) pos = 9;
        }
        resultado = soma % 11 < 2 ? 0 : 11 - (soma % 11);
        if (resultado !== parseInt(digitos.charAt(1))) return false;

        return true;
    }

    private async handlePixExpired(
        from: string,
        userMessage: string,
        state: ConversationDto
    ): Promise<ResponseStructureExtended[]> {
        let sentMessages: ResponseStructureExtended[] = [];
        const userChoice = userMessage.trim().toLowerCase();

        // Handle regeneration of new PIX QR code case
        const isRegeneratePix = userChoice === '1' ||
            userChoice.includes('sim') ||
            userChoice.includes('gerar') ||
            userChoice.includes('novo') ||
            userMessage.startsWith('button_regenerate_pix:');

        // Remove credit card option checks and just focus on PIX regeneration
        // The "No, go back" option can still be kept

        if (isRegeneratePix) {
            // PIX Regeneration logic - this can stay the same
            const updatedContext: ConversationContextDTO = {
                ...state.conversationContext,
                currentStep: ConversationStep.WaitingForPayment,
            };

            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: updatedContext,
            });

            // Generate new transaction
            const transactionResponse = await this.createTransaction(
                state,
                PaymentMethod.PIX,
                state.conversationContext.userName || 'Unknown',
            );

            // Create the PIX payment and get instructions
            sentMessages = await this.handlePIXPaymentInstructions(
                from,
                state,
                transactionResponse.pixKey
            );
        } else {
            // For any other response that's not regenerate PIX, present the options again
            const regeneratePIXBtn = this.whatsappApi.createInteractiveButtonMessage(
                from,
                'Você deseja gerar um novo código PIX para realizar o pagamento?',
                [
                    { id: 'regenerate_pix', title: 'Gerar novo PIX' }
                ],
                {
                    headerType: 'text',
                    headerContent: 'PIX Expirado',
                    footerText: 'O código PIX anterior não é mais válido.'
                }
            );

            sentMessages.push(regeneratePIXBtn);
        }

        return sentMessages;
    }




    private async createTransaction(
        state: ConversationDto,
        paymentMethod: PaymentMethod,
        userName: string
    ): Promise<{ transactionResponse: TransactionDTO, pixKey: string }> {
        this.logger.log(`[createTransaction] userId: ${state.userId} paymentMethod: ${paymentMethod}`);

        const transactionData: CreateTransactionDTO = {
            orderId: state.orderId,
            tableId: state.tableId,
            conversationId: state._id.toString(),
            userId: state.userId,
            amountPaid: 0,
            expectedAmount: this.formatToTwoDecimalPlaces(state.conversationContext.userAmount),
            status: PaymentStatus.Pending,
            initiatedAt: new Date(),
            paymentMethod: paymentMethod,
        };

        const transactionResponse = await this.transactionService.createTransaction(transactionData);
        const transactionId = transactionResponse.data._id.toString();

        if (paymentMethod === PaymentMethod.PIX) {
            const userPaymentInfo: UserPaymentPixInfoDto = {
                transactionId: transactionId,
                pixExpiresIn: 600, // 10 minutes in seconds
                customerInfo: {
                    name: userName,
                    cpf_cnpj: state.conversationContext.documentNumber,
                }
            };

            try {
                const ipagResponse = await this.ipagService.createPIXPayment(userPaymentInfo);
                const ipagTransactionId = ipagResponse.uuid;
                const pixKey = ipagResponse.attributes.pix.qrcode;

                await this.transactionService.updateTransaction(transactionId, { ipagTransactionId, expiresAt: new Date(Date.now() + 1000 * 60 * 10) }); // 10 minutes from now

                return { transactionResponse: transactionResponse.data, pixKey };
            } catch (error) {
                this.logger.error(`[createTransaction] Error generating PIX: ${error.message}`);

                // Atualiza o status da transação para falha
                await this.transactionService.updateTransaction(transactionId, {
                    status: PaymentStatus.Denied,
                });

                // Atualiza o contexto para seleção do método de pagamento
                const revertContext: ConversationContextDTO = {
                    ...state.conversationContext,
                    currentStep: ConversationStep.PaymentMethodSelection,
                };

                await this.conversationService.updateConversation(state._id.toString(), {
                    userId: state.userId,
                    conversationContext: revertContext,
                });

                // Adiciona uma mensagem de erro amigável
                throw new Error('Desculpe, houve um problema ao gerar o PIX. Por favor, tente novamente ou escolha outro método de pagamento.');
            }
        }

        return { transactionResponse: transactionResponse.data, pixKey: null };
    }




    // private async handlePaymentMethodSelection(
    //     from: string,
    //     userMessage: string,
    //     state: ConversationDto,
    // ): Promise<ResponseStructureExtended[]> {
    //     let sentMessages: ResponseStructureExtended[] = [];
    //     const conversationId = state._id.toString();
    //     const userChoice = userMessage.trim().toLowerCase();

    //     // Handle button responses
    //     const isPIXChoice = userChoice === '1' ||
    //         userChoice.includes('pix') ||
    //         userMessage.startsWith('button_payment_pix:');

    //     const isCreditCardChoice = userChoice === '2' ||
    //         userChoice.includes('cartão') ||
    //         userChoice.includes('cartao') ||
    //         userChoice.includes('crédito') ||
    //         userChoice.includes('credito') ||
    //         userMessage.startsWith('button_payment_credit:');

    //     if (isPIXChoice) {
    //         // PIX flow
    //         const updatedContext: ConversationContextDTO = {
    //             ...state.conversationContext,
    //             currentStep: ConversationStep.CollectName,
    //             paymentMethod: PaymentMethod.PIX,
    //         };

    //         await this.conversationService.updateConversation(conversationId, {
    //             userId: state.userId,
    //             conversationContext: updatedContext,
    //         });

    //         sentMessages.push(
    //             ...this.mapTextMessages(
    //                 ['😊 Para continuarmos com o pagamento via PIX\n\n*Qual é o seu nome completo?*'],
    //                 from,
    //             ),
    //         );
    //     } else if (isCreditCardChoice) {
    //         // Retrieve saved cards
    //         const cardsResponse = await this.cardService.getCardsByUserId(state.userId);
    //         const savedCards = cardsResponse.data;

    //         if (savedCards && savedCards.length > 0) {
    //             // Update conversation context
    //             const updatedContext: ConversationContextDTO = {
    //                 ...state.conversationContext,
    //                 currentStep: ConversationStep.SelectSavedCard,
    //                 paymentMethod: PaymentMethod.CREDIT_CARD,
    //                 savedCards: savedCards as CardDto[],
    //             };

    //             await this.conversationService.updateConversation(conversationId, {
    //                 userId: state.userId,
    //                 conversationContext: updatedContext,
    //             });

    //             // Build unique cards (with formatted display text)
    //             const uniqueCards = [];
    //             const processedCardKeys = new Set();

    //             for (let i = 0; i < savedCards.length; i++) {
    //                 const card = savedCards[i];
    //                 const cardKey = `${card.last4}_${card.expiry_month}_${card.expiry_year}`;

    //                 if (!processedCardKeys.has(cardKey)) {
    //                     processedCardKeys.add(cardKey);

    //                     // Check if we already have a card with the same last4 (regardless of expiration)
    //                     const sameLastFourIndex = uniqueCards.findIndex(c => c.last4 === card.last4);

    //                     if (sameLastFourIndex >= 0) {
    //                         // Update the display format without the expiration info
    //                         uniqueCards[sameLastFourIndex].displayText =
    //                             `${sameLastFourIndex + 1}- Final ${uniqueCards[sameLastFourIndex].last4}`;

    //                         // Add this card with the same simple format
    //                         uniqueCards.push({
    //                             ...card,
    //                             displayText: `${i + 1}- Final ${card.last4}`
    //                         });
    //                     } else {
    //                         // Add card with simple format (without expiration)
    //                         uniqueCards.push({
    //                             ...card,
    //                             displayText: `${i + 1}- Final ${card.last4}`
    //                         });
    //                     }
    //                 }
    //             }

    //             // Build interactive buttons (up to 2) based on the unique cards
    //             const buttons: InteractiveButton[] = [];
    //             const maxCardButtons = Math.min(uniqueCards.length, 2);
    //             for (let i = 0; i < maxCardButtons; i++) {
    //                 const card = uniqueCards[i];
    //                 buttons.push({
    //                     id: `card_${i + 1}`,
    //                     title: card.displayText
    //                 });
    //             }
    //             // Always add the "Novo Cartão" button
    //             buttons.push({
    //                 id: "new_card",
    //                 title: "💳 Novo Cartão"
    //             });

    //             // Create the interactive message
    //             const cardSelectionMessage = this.whatsappApi.createInteractiveButtonMessage(
    //                 from,
    //                 `✨ Com qual cartão deseja pagar o valor de *${formatToBRL(state.conversationContext.userAmount)}*?`,
    //                 buttons,
    //                 {
    //                     headerType: "text",
    //                     headerContent: "Selecione um Cartão",
    //                     footerText: "Para excluir um cartão salvo, digite: *deletar <número>*"
    //                 }
    //             );

    //             // If there are more than 2 cards, send only the text message listing them
    //             if (savedCards.length > 2) {
    //                 const textMessage = `Você tem ${savedCards.length} cartões salvos:\n\n` +
    //                     savedCards.map((card, index) =>
    //                         `${index + 1}- Final *${card.last4}*`
    //                     ).join('\n') +
    //                     `\n\n${savedCards.length + 1}- *💳 Novo Cartão*` +
    //                     `\n\nPara excluir um cartão salvo, digite: *deletar <número>*`;
    //                 sentMessages.push(...this.mapTextMessages([textMessage], from));
    //             } else {
    //                 // If 2 or fewer cards, use interactive buttons only.
    //                 sentMessages.push(cardSelectionMessage);
    //             }
    //         } else {
    //             // No saved cards – proceed to new card flow
    //             const updatedContext: ConversationContextDTO = {
    //                 ...state.conversationContext,
    //                 currentStep: ConversationStep.WaitingForPayment,
    //                 paymentMethod: PaymentMethod.CREDIT_CARD,
    //             };

    //             await this.conversationService.updateConversation(conversationId, {
    //                 userId: state.userId,
    //                 conversationContext: updatedContext,
    //             });

    //             const transactionResponse = await this.createTransaction(
    //                 state,
    //                 PaymentMethod.CREDIT_CARD,
    //                 state.conversationContext.userName,
    //             );

    //             this.logger.log(
    //                 `[handlePaymentMethodSelection] Transaction created: ${transactionResponse.transactionResponse._id}`,
    //             );

    //             sentMessages = await this.handleCreditCardPayment(
    //                 from,
    //                 state,
    //                 transactionResponse.transactionResponse,
    //             );
    //         }
    //     } else {
    //         // Invalid option – show payment method buttons
    //         const invalidOptionMessage = this.whatsappApi.createInteractiveButtonMessage(
    //             from,
    //             "Escolha uma das formas abaixo:",
    //             [
    //                 { id: "payment_pix", title: "PIX" },
    //                 // { id: "payment_credit", title: "Cartão de Crédito" }
    //             ],
    //             {
    //                 headerType: "text",
    //                 headerContent: "Método de Pagamento",
    //                 footerText: "Selecione uma das opções abaixo"
    //             }
    //         );

    //         sentMessages.push(invalidOptionMessage);
    //     }

    //     return sentMessages;
    // }

    // private async handleSelectSavedCard(
    //     from: string,
    //     userMessage: string,
    //     state: ConversationDto,
    // ): Promise<ResponseStructureExtended[]> {
    //     let sentMessages: ResponseStructureExtended[] = [];
    //     const conversationId = state._id.toString();
    //     const savedCards: CardDto[] = state.conversationContext.savedCards || [];
    //     const totalOptions = savedCards.length + 1; // inclui a opção "Novo Cartão"

    //     // Função auxiliar para determinar o texto de exibição de cada cartão (sem exibir data de validade)
    //     const getCardDisplayText = (card: Omit<CardDto, "token">, allCards: Omit<CardDto, "token">[]): string => {
    //         return `${allCards.indexOf(card) + 1}- Final ${card.last4}`;
    //     };

    //     // Verifica se o usuário digitou "deletar", "remover", etc.
    //     const normalizedInput = userMessage.trim().toLowerCase();
    //     const deleteMatch = normalizedInput.match(/^(deletar|remover)\s+(\d+)/i);

    //     if (deleteMatch) {
    //         const indexToDelete = parseInt(deleteMatch[2], 10);

    //         if (isNaN(indexToDelete) || indexToDelete < 1 || indexToDelete > savedCards.length) {
    //             sentMessages.push(
    //                 ...this.mapTextMessages(
    //                     ['Número inválido. Digite: *deletar <número>*'],
    //                     from,
    //                 ),
    //             );
    //             return sentMessages;
    //         }

    //         const cardToDelete = savedCards[indexToDelete - 1];
    //         if (!cardToDelete) {
    //             sentMessages.push(
    //                 ...this.mapTextMessages(
    //                     ['Cartão não encontrado. Digite: *deletar <número>*'],
    //                     from,
    //                 ),
    //             );
    //             return sentMessages;
    //         }

    //         // Deleta o cartão
    //         await this.cardService.deleteCard(cardToDelete._id, state.userId);

    //         // Atualiza a lista de cartões
    //         const updatedCardsResponse = await this.cardService.getCardsByUserId(state.userId);
    //         const updatedCards = updatedCardsResponse.data || [];

    //         const updatedContext: ConversationContextDTO = {
    //             ...state.conversationContext,
    //             savedCards: updatedCards as CardDto[],
    //         };
    //         await this.conversationService.updateConversation(conversationId, {
    //             userId: state.userId,
    //             conversationContext: updatedContext,
    //         });

    //         if (updatedCards.length > 0 && updatedCards.length <= 2) {
    //             const buttons: InteractiveButton[] = updatedCards.map((card, index) => ({
    //                 id: `${index + 1}`,
    //                 title: getCardDisplayText(card, updatedCards),
    //             }));

    //             buttons.push({ id: `${updatedCards.length + 1}`, title: '💳 Novo Cartão' });

    //             const interactiveMessage = this.whatsappApi.createInteractiveButtonMessage(
    //                 from,
    //                 '✅ Cartão removido! Escolha outro ou cadastre um novo:',
    //                 buttons,
    //                 {
    //                     headerType: 'text',
    //                     headerContent: 'Selecione um Cartão',
    //                     footerText: 'Para excluir um cartão salvo, digite: *deletar <número>*',
    //                 }
    //             );

    //             sentMessages.push(interactiveMessage);
    //         } else if (updatedCards.length > 0) {
    //             let optionsMessage = '✅ Cartão removido!\n\nEstes são seus cartões atuais:\n\n';
    //             updatedCards.forEach((card, index) => {
    //                 optionsMessage += `${index + 1}- ${getCardDisplayText(card, updatedCards)}\n`;
    //             });
    //             optionsMessage += `${updatedCards.length + 1}- *💳 Novo Cartão*\n\n`;
    //             optionsMessage += `Para excluir um cartão salvo, digite: *deletar <número>*`;

    //             sentMessages.push(...this.mapTextMessages([optionsMessage], from));
    //         } else {
    //             sentMessages.push(...this.mapTextMessages([
    //                 '✅ Cartão removido!\n\nVocê não possui mais cartões salvos.\nDigite *1* para adicionar um novo cartão.'
    //             ], from));
    //         }

    //         return sentMessages;
    //     }

    //     let selection: number = NaN;
    //     if (userMessage.startsWith("button_card_")) {
    //         selection = parseInt(userMessage.replace("button_card_", "").trim(), 10);
    //     }

    //     else if (normalizedInput.includes("novo cartao") ||
    //         normalizedInput.includes("novo cartão") ||
    //         normalizedInput === "💳 novo cartão") {
    //         selection = totalOptions;
    //     }
    //     else {
    //         const selectionMatch = userMessage.trim().match(/^(\d+)/);
    //         selection = selectionMatch ? parseInt(selectionMatch[1], 10) : NaN;
    //     }

    //     if (isNaN(selection) || selection < 1 || selection > totalOptions) {
    //         sentMessages.push(
    //             ...this.mapTextMessages(
    //                 ['Escolha uma opção válida ou digite *deletar <número>* para remover um cartão.'],
    //                 from,
    //             ),
    //         );
    //         return sentMessages;
    //     }

    //     if (selection === totalOptions) {
    //         const updatedContext: ConversationContextDTO = {
    //             ...state.conversationContext,
    //             currentStep: ConversationStep.WaitingForPayment,
    //         };
    //         await this.conversationService.updateConversation(conversationId, {
    //             userId: state.userId,
    //             conversationContext: updatedContext,
    //         });

    //         const transactionResponse = await this.createTransaction(
    //             state,
    //             PaymentMethod.CREDIT_CARD,
    //             state.conversationContext.userName,
    //         );

    //         sentMessages = await this.handleCreditCardPayment(
    //             from,
    //             state,
    //             transactionResponse.transactionResponse,
    //         );
    //         return sentMessages;
    //     }

    //     const selectedCard = savedCards[selection - 1];

    //     const updatedContext: ConversationContextDTO = {
    //         ...state.conversationContext,
    //         currentStep: ConversationStep.WaitingForPayment,
    //         selectedCardId: selectedCard._id,
    //     };
    //     await this.conversationService.updateConversation(conversationId, {
    //         userId: state.userId,
    //         conversationContext: updatedContext,
    //     });

    //     const transactionResponse = await this.createTransaction(
    //         state,
    //         PaymentMethod.CREDIT_CARD,
    //         state.conversationContext.userName,
    //     );

    //     const userPaymentInfo: UserPaymentCreditInfoDto = {
    //         transactionId: transactionResponse.transactionResponse._id.toString(),
    //         cardId: selectedCard._id,
    //     };

    //     try {
    //         await this.ipagService.createCreditCardPayment(userPaymentInfo);
    //     } catch (error) {
    //         console.log("iPAG CREDIT CARD ERROR", error);
    //         const revertContext: ConversationContextDTO = {
    //             ...state.conversationContext,
    //             currentStep: ConversationStep.SelectSavedCard,
    //         };

    //         await this.conversationService.updateConversation(conversationId, {
    //             userId: state.userId,
    //             conversationContext: revertContext,
    //         });

    //         if (savedCards.length <= 2) {
    //             const buttons: InteractiveButton[] = savedCards.map((card, index) => ({
    //                 id: `${index + 1}`,
    //                 title: getCardDisplayText(card, savedCards),
    //             }));

    //             buttons.push({ id: `${savedCards.length + 1}`, title: '💳 Novo Cartão' });

    //             const interactiveMessage = this.whatsappApi.createInteractiveButtonMessage(
    //                 from,
    //                 '*Erro no pagamento!* Escolha outro cartão ou cadastre um novo:',
    //                 buttons,
    //                 {
    //                     headerType: 'text',
    //                     headerContent: 'Erro no Pagamento',
    //                     footerText: 'Para excluir um cartão salvo, digite: *deletar <número>*',
    //                 }
    //             );

    //             sentMessages.push(interactiveMessage);
    //         } else {
    //             let optionsMessage = `*Erro no pagamento!* Escolha outro cartão:\n\n`;
    //             savedCards.forEach((card, index) => {
    //                 optionsMessage += `${index + 1}- ${getCardDisplayText(card, savedCards)}\n`;
    //             });
    //             optionsMessage += `${savedCards.length + 1}- *💳 Novo Cartão*\n\n`;
    //             optionsMessage += `Para excluir um cartão salvo, digite: *deletar <número>*`;

    //             sentMessages.push(...this.mapTextMessages([optionsMessage], from));
    //         }

    //         return sentMessages;
    //     }

    //     return sentMessages;
    // }


    private async handleCollectName(
        from: string,
        userMessage: string,
        state: ConversationDto
    ): Promise<ResponseStructureExtended[]> {
        let sentMessages: ResponseStructureExtended[] = [];
        const conversationId = state._id.toString();

        const name = userMessage.trim();
        this.logger.log(`[handleCollectName] name: ${name}`);

        if (!name) {
            sentMessages.push(
                ...this.mapTextMessages(['Por favor, informe um nome válido.'], from)
            );
            return sentMessages;
        }

        // Atualiza o contexto da conversa com o nome do usuário e avança para a etapa de pagamento
        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            userName: name,
            currentStep: ConversationStep.WaitingForPayment,
        };

        await this.conversationService.updateConversation(conversationId, {
            userId: state.userId,
            conversationContext: updatedContext,
        });

        // Tenta criar a transação via PIX
        try {
            const transactionResponse = await this.createTransaction(state, PaymentMethod.PIX, name);

            if (transactionResponse.pixKey) {
                const paymentMessages = await this.handlePIXPaymentInstructions(from, state, transactionResponse.pixKey);
                sentMessages.push(...paymentMessages);
            } else {
                throw new Error('PIX key not received');
            }
        } catch (error) {
            this.logger.error(`[handleCollectName] Error generating PIX: ${error.message}`);


            // Atualiza o contexto para seleção do método de pagamento
            const revertContext: ConversationContextDTO = {
                ...state.conversationContext,
                currentStep: ConversationStep.WaitingForPayment,
            };

            await this.conversationService.updateConversation(conversationId, {
                userId: state.userId,
                conversationContext: revertContext,
            });

            const paymentMethodMessage = this.whatsappApi.createInteractiveButtonMessage(
                from,
                'Houve um erro na geração do PIX. Deseja tentar novamente?',
                [
                    { id: "payment_pix", title: "Tentar Novamente" },
                    { id: "no_back_to_start", title: "Não, voltar para o início" }
                ],
                {
                    headerType: "text",
                    headerContent: "Erro no Pagamento",
                    footerText: ""
                }
            );

            sentMessages.push(paymentMethodMessage);
        }

        return sentMessages;
    }

    // private async handleCreditCardPayment(
    //     from: string,
    //     state: ConversationDto,
    //     transactionResponse: TransactionDTO
    // ): Promise<ResponseStructureExtended[]> {
    //     let sentMessages: ResponseStructureExtended[] = [];
    //     // Get payment link for fallback
    //     const isDemo = process.env.ENVIRONMENT === 'demo';
    //     const paymentLink = `${process.env.CREDIT_CARD_PAYMENT_LINK}?transactionId=${transactionResponse._id}${isDemo ? '&environment=sandbox' : ''}`;
    //     this.logger.log(`[handleCreditCardPayment] paymentLink: ${paymentLink}`);

    //     try {
    //         const flowId = this.environment === 'demo' ? process.env.WHATSAPP_DEMO_CREDITCARD_FLOW_ID : this.environment === 'homologation' || this.environment === 'development' ? process.env.WHATSAPP_TEST_CREDITCARD_FLOW_ID : process.env.WHATSAPP_PROD_CREDITCARD_FLOW_ID;
    //         const flowName = this.environment === 'demo' ? process.env.WHATSAPP_DEMO_CREDITCARD_FLOW_NAME : this.environment === 'homologation' || this.environment === 'development' ? process.env.WHATSAPP_TEST_CREDITCARD_FLOW_NAME : process.env.WHATSAPP_PROD_CREDITCARD_FLOW_NAME;

    //         this.logger.log(`[handleCreditCardPayment] flowId: ${flowId}`);
    //         this.logger.log(`[handleCreditCardPayment] flowName: ${flowName}`);

    //         if (!flowId && !flowName) {
    //             this.logger.warn('WhatsApp Credit Card Flow ID/Name not configured. Falling back to regular payment link message.');
    //             // Fallback to regular text message if flow is not configured
    //             sentMessages.push(...this.mapTextMessages(
    //                 [
    //                     `O valor final da conta é de *${formatToBRL(state.conversationContext.userAmount)}*.`,
    //                     `*Clique no link abaixo* para realizar o pagamento com Cartão de Crédito:`,
    //                     paymentLink,
    //                     `*Não consegue clicar no link?*\n\n*Salve* nosso contato na agenda.\nOu copie e cole em seu navegador.`
    //                 ],
    //                 from
    //             ));
    //         } else {
    //             // Prepare data for the flow - use a simpler approach without complex payload
    //             try {
    //                 // Create a basic flow message with minimal configuration

    //                 console.log("HOLDER CPF", state.conversationContext.documentNumber);

    //                 const flowMessage = this.whatsappApi.createFlowMessage(
    //                     from,
    //                     `O valor final da conta é de ${formatToBRL(state.conversationContext.userAmount)}. Preencha os dados do seu cartão para finalizar o pagamento.`,
    //                     {
    //                         flowId: flowId,
    //                         flowCta: 'Pagar com cartão',
    //                         mode: 'published',
    //                         flowToken: state._id.toString(),
    //                         flowAction: 'navigate',
    //                         flowActionPayload: {
    //                             screen: "USER_INFO",
    //                             data: {
    //                                 holder_cpf: this.utilsService.formatCPF(state.conversationContext.documentNumber || ''),
    //                                 payment_value: "💰 Valor: " + formatToBRL(state.conversationContext.userAmount),
    //                                 table_id: "🪑 Comanda: " + state.tableId,
    //                                 transaction_id: transactionResponse._id.toString()
    //                             }
    //                         }
    //                     },
    //                     {
    //                         headerType: 'text',
    //                         headerContent: 'Pagamento com Cartão',
    //                         footerText: 'Astra - Pagamento Seguro'
    //                     }
    //                 );

    //                 console.log(`[handleCreditCardPayment] flowMessage: ${JSON.stringify(flowMessage)}`);

    //                 // Add an informative message about the payment process
    //                 sentMessages.push(
    //                     ...this.mapTextMessages(
    //                         [
    //                             `Você será guiado para inserir os dados do seu cartão diretamente no WhatsApp de forma segura.`,
    //                         ],
    //                         from
    //                     ),
    //                     flowMessage
    //                 );



    //             } catch (flowError) {
    //                 this.logger.error(`[handleCreditCardPayment] Flow error: ${flowError.message}`, flowError.stack);

    //                 // After flow error, try with the explicit navigate action as a fallback
    //                 try {
    //                     this.logger.log(`[handleCreditCardPayment] Trying with explicit flow action and payload`);

    //                     const flowMessage = this.whatsappApi.createFlowMessage(
    //                         from,
    //                         `O valor final da conta é de ${formatToBRL(state.conversationContext.userAmount)}. Preencha os dados do seu cartão para finalizar o pagamento.`,
    //                         {
    //                             flowId: flowId,
    //                             flowCta: 'Pagar com cartão',
    //                             flowAction: 'navigate',
    //                             flowActionPayload: {
    //                                 screen: "CREDIT_CARD",
    //                                 data: {
    //                                     SUMMARY: {
    //                                         holder_cpf: state.conversationContext.documentNumber || ''
    //                                     }
    //                                 }
    //                             },
    //                             mode: 'published' // Try published instead of draft
    //                         },
    //                         {
    //                             headerType: 'text',
    //                             headerContent: 'Pagamento com Cartão',
    //                             footerText: 'Astra - Pagamento Seguro'
    //                         }
    //                     );

    //                     await this.whatsappApi.sendWhatsAppMessage(flowMessage);
    //                     this.logger.log(`[handleCreditCardPayment] Flow message with explicit action sent successfully`);
    //                 } catch (explicitFlowError) {
    //                     this.logger.error(`[handleCreditCardPayment] Explicit flow error: ${explicitFlowError.message}`, explicitFlowError.stack);
    //                     throw flowError; // Re-throw the original error to be caught by the outer catch block
    //                 }

    //                 // Add an informative message about the payment process
    //                 sentMessages.push(
    //                     ...this.mapTextMessages(
    //                         [
    //                             `Você será guiado para inserir os dados do seu cartão diretamente no WhatsApp de forma segura.`,
    //                             `Se preferir acessar diretamente pelo navegador, use o link: ${paymentLink}`
    //                         ],
    //                         from
    //                     )
    //                 );
    //             }
    //         }
    //     } catch (error) {
    //         this.logger.error(`Error sending credit card flow message: ${error.message || error}`);
    //         // Fallback to regular text message if flow fails
    //         sentMessages.push(...this.mapTextMessages(
    //             [
    //                 `O valor final da conta é de *${formatToBRL(state.conversationContext.userAmount)}*.`,
    //                 `*Clique no link abaixo* para realizar o pagamento com Cartão de Crédito:`,
    //                 paymentLink,
    //                 `*Não consegue clicar no link?*\n\n*Salve* nosso contato na agenda.\nOu copie e cole em seu navegador.`
    //             ],
    //             from
    //         ));
    //     }

    //     // Update conversation state
    //     const conversationId = state._id.toString();
    //     const updatedContext: ConversationContextDTO = {
    //         ...state.conversationContext,
    //         currentStep: ConversationStep.WaitingForPayment,
    //     };

    //     await this.conversationService.updateConversation(conversationId, {
    //         userId: state.userId,
    //         conversationContext: updatedContext,
    //     });

    //     this.logger.log(`[handleCreditCardPayment] Updated context}`);

    //     return sentMessages;
    // }

    public async processPayment(paymentData: PaymentProcessorDTO): Promise<void> {
        const { transactionId, from, state } = paymentData;
        this.logger.debug(`[processPayment] Processing payment, transactionId: ${transactionId}`);

        let sentMessages: ResponseStructureExtended[] = [];
        const transaction = await this.transactionService.getTransaction(transactionId);

        if (transaction.data.status !== PaymentStatus.Accepted) {
            // Check if there's a specific error from the Gateway
            if (transaction.data.errorDescription &&
                (transaction.data.errorDescription.errorCode === 'Gateway' ||
                    transaction.data.errorDescription.errorCode === 'acquirer')) {
                // Use the user-friendly error message
                sentMessages.push(
                    ...this.mapTextMessages(
                        [`*👋  Astra Pay* - Pagamento não aprovado ❌\n\n${transaction.data.errorDescription.userFriendlyMessage}`],
                        from
                    )
                );
            } else {
                // For general errors, provide alternative payment method options
                const errorMessage = '*👋  Astra Pay* - Erro ao processar o pagamento ❌\n\nPor favor, tente novamente ou escolha outro método de pagamento.';

                // Create interactive buttons for payment method selection
                const interactiveMessage = this.whatsappApi.createInteractiveButtonMessage(
                    from,
                    errorMessage,
                    [
                        { id: "payment_pix", title: "Pagar com PIX" },
                        { id: "payment_card", title: "Pagar com Cartão" },
                    ],
                    {
                        footerText: "Escolha uma opção para continuar"
                    }
                );

                const updatedContext: ConversationContextDTO = {
                    ...state.conversationContext,
                    currentStep: ConversationStep.PaymentMethodSelection,
                };

                await this.conversationService.updateConversation(state._id.toString(), {
                    userId: state.userId,
                    conversationContext: updatedContext,
                });

                sentMessages.push(interactiveMessage);
            }
        } else {

            const confirmationMessage = this.mapTextMessages(
                ['*👋  Astra Pay* - Pagamento Confirmado ✅\n\nEsperamos que sua experiência tenha sido excelente.'],
                from
            );

            const receiptMessagesPromise = this.generateReceiptPdf(transaction.data);

            // Replace text message with interactive buttons for feedback options
            const feedbackMessage = this.whatsappApi.createInteractiveButtonMessage(
                from,
                "Como você se sentiria se não pudesse mais usar o nosso serviço?",
                [
                    { id: "feedback_1", title: "Muito decepcionado" },
                    { id: "feedback_2", title: "Pouco decepcionado" },
                    { id: "feedback_3", title: "Não faria diferença" }
                ],
                {
                    headerType: "text",
                    headerContent: "Sua opinião é importante",
                    footerText: "Ajude-nos a melhorar"
                }
            );

            const receiptMessages = await receiptMessagesPromise;

            sentMessages.push(...confirmationMessage, ...receiptMessages);
            sentMessages.push(feedbackMessage);


            // Atualiza o estado da conversa para a etapa de Feedback
            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: {
                    ...state.conversationContext,
                    currentStep: ConversationStep.Feedback,
                },
            });

            this.logger.log(`[processPayment] Updating amount paid and checking order status`);

            const updateAmountResponse = await this.orderService.updateAmountPaidAndCheckOrderStatus(state.orderId, transaction.data.amountPaid, state.userId);
            this.logger.log(`[processPayment] updateAmountResponse: ${updateAmountResponse}`);
            const isFullPaymentAmountPaid = updateAmountResponse.data.isPaid;

            this.logger.log(`[processPayment] isFullPaymentAmountPaid: ${isFullPaymentAmountPaid}`);

            if (isFullPaymentAmountPaid) {
                this.logger.log(`[processPayment] Full payment amount paid`);
                const tableId = parseInt(state.tableId);
                try {
                    await this.tableService.finishPayment(tableId, transaction.data.paymentMethod);
                } catch (error) {
                    this.logger.error(`[processPayment] Error finishing payment: ${error.message}`);
                }
                const notifyWaiterMessages = await this.notifyWaiterTablePaymentComplete(state);
                sentMessages.push(...notifyWaiterMessages);
            } else {
                this.logger.log(`[processPayment] Partial payment amount paid`);
                const notifyWaiterMessages = await this.notifyWaiterPaymentMade(state);
                sentMessages.push(...notifyWaiterMessages);
            }
        }

        // Envia as mensagens diretamente para o bot GO
        await this.sendMessagesDirectly(sentMessages);
    }

    private async sendMessagesDirectly(messages: ResponseStructureExtended[]): Promise<void> {
        await this.whatsappApi.sendWhatsAppMessages(messages);
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
        state: ConversationDto
    ): Promise<ResponseStructureExtended[]> {
        let sentMessages: ResponseStructureExtended[] = [];
        const conversationId = state._id.toString();

        if (!state.conversationContext.feedback) {
            state.conversationContext.feedback = new FeedbackDTO();
        }

        const feedback = state.conversationContext.feedback;
        let updatedContext: ConversationContextDTO = { ...state.conversationContext };

        console.log("feedback", feedback);

        if (typeof feedback.mustHaveScore === 'undefined') {
            const userResponse = userMessage.trim().toLowerCase();

            // Define valid options for text responses
            const validOptions: Record<string, string> = {
                '1-': 'Muito decepcionado',
                '1': 'Muito decepcionado',
                'muito decepcionado': 'Muito decepcionado',
                'decepcionado': 'Muito decepcionado',
                '2-': 'Um pouco decepcionado',
                '2': 'Um pouco decepcionado',
                'um pouco decepcionado': 'Um pouco decepcionado',
                'pouco decepcionado': 'Um pouco decepcionado',
                '3-': 'Não faria diferença',
                '3': 'Não faria diferença',
                'não faria diferença': 'Não faria diferença',
                'nao faria diferença': 'Não faria diferença', // Sem acento
                'indiferente': 'Não faria diferença',
                // Button response patterns
                'button_feedback_1': 'Muito decepcionado',
                'button_feedback_2': 'Um pouco decepcionado',
                'button_feedback_3': 'Não faria diferença'
            };

            // Verifica se a resposta do usuário é válida
            const isButtonResponse = userMessage.startsWith('button_feedback_');
            let matchedOption;

            if (isButtonResponse) {
                // Extract button ID from response (e.g., 'button_feedback_1:Muito decepcionado' -> 'button_feedback_1')
                const buttonId = userMessage.split(':')[0];
                matchedOption = buttonId;
            } else {
                // Check for text responses
                matchedOption = Object.keys(validOptions).find(
                    (key) => key === userResponse || userResponse.includes(key)
                );
            }

            if (userMessage.includes("interação de botão desconhecida") || userMessage.includes("desconhecida")) {
                return sentMessages;
            }

            if (!matchedOption) {
                const feedbackOptionsMessage = this.whatsappApi.createInteractiveButtonMessage(
                    from,
                    "Por favor, avalie c`omo foi sua experiência conosco:",
                    [
                        { id: "feedback_1", title: "Muito decepcionado" },
                        { id: "feedback_2", title: "Pouco decepcionado" },
                        { id: "feedback_3", title: "Não faria diferença" }
                    ],
                    {
                        headerType: "text",
                        headerContent: "Sua opinião é importante",
                        footerText: ""
                    }
                );

                sentMessages.push(feedbackOptionsMessage);
            } else {
                feedback.mustHaveScore = validOptions[matchedOption];

                sentMessages = this.mapTextMessages(
                    ['Entendemos. Pode nos contar um pouco mais sobre o motivo da sua escolha?'],
                    from
                );

                updatedContext.currentStep = ConversationStep.FeedbackDetail;
            }
        } else {
            sentMessages = this.mapTextMessages(
                ['Parece que já registramos sua avaliação. Obrigado!'],
                from
            );
        }

        await this.conversationService.updateConversation(conversationId, {
            userId: state.userId,
            conversationContext: updatedContext,
        });

        return sentMessages;
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
        state: ConversationDto
    ): Promise<ResponseStructureExtended[]> {
        let sentMessages: ResponseStructureExtended[] = [];
        const conversationId = state._id.toString();

        if (!state.conversationContext.feedback) {
            state.conversationContext.feedback = new FeedbackDTO();
        }

        const feedback = state.conversationContext.feedback;

        if (!feedback.detailedFeedback) {
            feedback.detailedFeedback = userMessage.trim();

            if (feedback.mustHaveScore === 'Muito decepcionado' || feedback.mustHaveScore === 'Um pouco decepcionado') {
                // For disappointed users, we ask for suggestions of other restaurants
                sentMessages.push(
                    ...this.mapTextMessages(
                        ['Obrigado pelo seu feedback detalhado!'],
                        from
                    )
                );

                // Add a message asking for restaurant suggestions with a friendly tone
                const restaurantMessage = this.whatsappApi.createInteractiveButtonMessage(
                    from,
                    "Em qual outro restaurante você gostaria de pagar com a Astra?",
                    [
                        { id: "restaurant_suggest", title: "Sugerir restaurante" },
                        { id: "restaurant_skip", title: "Pular" }
                    ],
                    {
                        headerType: "text",
                        headerContent: "Sua sugestão é valiosa",
                        footerText: ""
                    }
                );

                sentMessages.push(restaurantMessage);

                await this.conversationService.updateConversation(conversationId, {
                    userId: state.userId,
                    conversationContext: {
                        ...state.conversationContext,
                        currentStep: ConversationStep.FeedbackDetail,
                    },
                });
            } else {
                // For satisfied users, we just thank them
                sentMessages = this.mapTextMessages(
                    [
                        'Obrigado pelo seu feedback detalhado! 😄',
                        'Se precisar de algo mais, estamos aqui para ajudar. Até breve!',
                    ],
                    from
                );

                await this.conversationService.updateConversation(conversationId, {
                    userId: state.userId,
                    conversationContext: {
                        ...state.conversationContext,
                        currentStep: ConversationStep.Completed,
                    },
                });
            }
        } else if (
            !feedback.recommendedRestaurants &&
            (feedback.mustHaveScore === 'Muito decepcionado' || feedback.mustHaveScore === 'Um pouco decepcionado')
        ) {
            // Handle restaurant suggestion or skip
            if (userMessage.startsWith('button_restaurant_skip:')) {
                // User chose to skip suggesting restaurants
                sentMessages = this.mapTextMessages(
                    [
                        'Sem problemas! 😊',
                        'Agradecemos seu feedback. Se precisar de algo mais, estamos aqui para ajudar.',
                    ],
                    from
                );

                feedback.recommendedRestaurants = "Usuário optou por não sugerir";

                await this.conversationService.updateConversation(conversationId, {
                    userId: state.userId,
                    conversationContext: {
                        ...state.conversationContext,
                        currentStep: ConversationStep.Completed,
                    },
                });
            } else if (userMessage.startsWith('button_restaurant_suggest:')) {
                // User clicked the suggest button, prompt for actual suggestion
                sentMessages = this.mapTextMessages(
                    ['Por favor, digite o nome do(s) restaurante(s) que você gostaria de sugerir:'],
                    from
                );
            } else {
                // Normal text input with restaurant suggestion
                const recommended = userMessage.trim();
                if (!recommended) {
                    // Empty message, ask again with buttons
                    const restaurantMessage = this.whatsappApi.createInteractiveButtonMessage(
                        from,
                        "Em qual outro restaurante você gostaria de pagar com a Astra?",
                        [
                            { id: "restaurant_suggest", title: "Sugerir restaurante" },
                            { id: "restaurant_skip", title: "Pular" }
                        ],
                        {
                            headerType: "text",
                            headerContent: "Sua sugestão é valiosa",
                            footerText: ""
                        }
                    );

                    sentMessages.push(restaurantMessage);
                } else {
                    // User provided restaurant suggestions
                    feedback.recommendedRestaurants = recommended;

                    sentMessages = this.mapTextMessages(
                        [
                            'Muito obrigado pelas suas indicações! 🤩',
                            'Se precisar de mais alguma coisa, estamos aqui para ajudar. 😄',
                        ],
                        from
                    );

                    await this.conversationService.updateConversation(conversationId, {
                        userId: state.userId,
                        conversationContext: {
                            ...state.conversationContext,
                            currentStep: ConversationStep.Completed,
                        },
                    });
                }
            }
        } else {
            sentMessages = this.mapTextMessages(
                ['Tudo certo! Obrigado mais uma vez pelo feedback!'],
                from
            );

            await this.conversationService.updateConversation(conversationId, {
                userId: state.userId,
                conversationContext: {
                    ...state.conversationContext,
                    currentStep: ConversationStep.Completed,
                },
            });
        }

        return sentMessages;
    }

    private async handleUserAbandoned(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<ResponseStructureExtended[]> {
        const sentMessages: ResponseStructureExtended[] = [];
        const conversationId = state._id.toString();

        if (!state.conversationContext.feedback) {
            state.conversationContext.feedback = {};
        }

        state.conversationContext.feedback.userAbandoned = userMessage.trim();

        sentMessages.push(
            ...this.mapTextMessages(
                [
                    'Obrigado por nos contar. 😢\n' +
                    'Anotamos sua resposta e sentiremos falta de concluir seu pedido por aqui.'
                ],
                from
            ),
            ...this.mapTextMessages(
                [
                    'Se mudar de ideia ou precisar de ajuda, é só mandar outra mensagem!'
                ],
                from
            )
        );

        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            currentStep: ConversationStep.Completed,
        };

        await this.conversationService.updateConversation(conversationId, {
            userId: state.userId,
            conversationContext: updatedContext,
        });

        return sentMessages;
    }

    private async handleDelayedPayment(from: string, userMessage: string, state: ConversationDto): Promise<ResponseStructureExtended[]> {
        const sentMessages: ResponseStructureExtended[] = [];
        const conversationId = state._id.toString();

        if (!state.conversationContext.feedback) {
            state.conversationContext.feedback = {};
        }

        state.conversationContext.feedback.delayedPayment = userMessage.trim();

        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            currentStep: ConversationStep.WaitingForPayment,
        };

        await this.conversationService.updateConversation(conversationId, {
            userId: state.userId,
            conversationContext: updatedContext,
        });

        sentMessages.push(
            ...this.mapTextMessages(
                [
                    'Obrigado por nos contar. 😢\n' +
                    'Anotamos sua resposta'
                ],
                from
            ),
        );

        return sentMessages;
    }


    private async notifyWaiterTableSplit(state: ConversationDto): Promise<ResponseStructureExtended[]> {
        const groupId = this.waiterGroupId;
        const message = `👋 Astra Pay - Mesa ${state.tableId} irá compartilhar o pagamento`;

        return this.mapTextMessages([message], groupId);
    }

    public async notifyWaiterTablePaymentComplete(state?: ConversationDto, conversationId?: string): Promise<ResponseStructureExtended[]> {
        const groupId = this.waiterGroupId;
        this.logger.log(`[notifyWaiterTablePaymentComplete] Notificação de pagamento completo para o grupo: ${groupId}`);

        try {
            let conversation = state;
            
            // If conversationId is provided, load the conversation
            if (conversationId) {
                const { data } = await this.conversationService.getConversation(conversationId);
                conversation = data;
            }
            
            const { orderId, tableId } = conversation;
            const { data: orderData } = await this.orderService.getOrder(orderId);
            const { totalAmount, amountPaidSoFar = 0 } = orderData;

            const extraTip = amountPaidSoFar - totalAmount;
            let tipMessage = '';

            if (extraTip > 0) {
                tipMessage = extraTip > 15
                    ? `MAIS ${formatToBRL(extraTip)} de Gorjeta 🎉`
                    : `MAIS ${conversation.conversationContext.tipPercent}% de Gorjeta 🎉`;
            }

            const message = tipMessage
                ? `*👋 Astra Pay* - ${tipMessage}\n\nA mesa ${tableId} pagou com sucesso 🚀`
                : `*👋 Astra Pay* - Mesa ${tableId} pagou com sucesso 🚀`;

            return this.mapTextMessages([message], groupId);
        } catch (error) {
            this.logger.error(`[notifyWaiterTablePaymentComplete] Error: ${error}`);
            return [];
        }
    }

    private async generateReceiptPdf(transaction: TransactionDTO): Promise<ResponseStructureExtended[]> {
        // Verificar se estamos em ambiente de produção e se precisamos usar a versão mock
        const isProduction = process.env.ENVIRONMENT === 'production';
        const isDemo = process.env.ENVIRONMENT === 'demo';
        const needsMock = isProduction && (!transaction.cardId && transaction.paymentMethod !== PaymentMethod.PIX);

        let cardLast4 = '';
        if (transaction.paymentMethod !== PaymentMethod.PIX && !needsMock) {
            try {
                const cardLast4Response = await this.cardService.getCardLast4(transaction.cardId);
                cardLast4 = cardLast4Response.data;
            } catch (error) {
                this.logger.warn(`[generateReceiptPdf] Não foi possível obter os últimos 4 dígitos do cartão: ${error.message}`);
            }
        } else if (needsMock && transaction.paymentMethod !== PaymentMethod.PIX && !isDemo) {
            // Usar dados mockados para o cartão em ambiente de produção, mas não em demo
            cardLast4 = '1234'; // Valor mockado para os últimos 4 dígitos
        }

        this.logger.log(`[generateReceiptPdf] Gerando comprovante de pagamento para a transação: ${transaction._id}`);

        const receiptData: ReceiptTemplateData = {
            isPIX: transaction.paymentMethod === PaymentMethod.PIX,
            statusTitle: transaction.status === PaymentStatus.Accepted ? 'Pagamento concluído' : 'Pagamento cancelado',
            amount: needsMock && !isDemo ? 'R$ 100,00' : formatToBRL(transaction.amountPaid),
            tableId: needsMock && !isDemo ? '42' : transaction.tableId,
            dateTime: needsMock && !isDemo ?
                new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' })
                    .replace(/(\d{2}\/\d{2}\/\d{4}), (\d{2}:\d{2})/, '$2, $1') :
                new Date(transaction.confirmedAt)
                    .toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' })
                    .replace(/(\d{2}\/\d{2}\/\d{4}), (\d{2}:\d{2})/, '$2, $1'),
            statusLabel: transaction.status === PaymentStatus.Accepted ? 'Confirmado' : 'Cancelado',
            cardLast4: cardLast4,
            whatsAppLink: "https://wa.me/551132803247",
            privacyLink: "https://astra1.com.br/privacy-policy/",
            termsLink: "https://astra1.com.br/terms-of-service/",
        };

        let pdfBuffer: Buffer | null = null;
        const maxAttempts = 5;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                pdfBuffer = await this.genReceiptService.generatePdf(receiptData);
                break; // Success, exit the loop
            } catch (error) {
                this.logger.error(`[generateReceiptPdf] Attempt ${attempt} failed: ${error.message}`);
                if (attempt === maxAttempts) {
                    this.logger.error(`[generateReceiptPdf] All ${maxAttempts} attempts failed. Returning empty message.`);
                    return [];
                }
            }
        }

        this.logger.log(`[generateReceiptPdf] Comprovante de pagamento gerado com sucesso`);

        const message: ResponseStructureExtended = {
            type: "document",
            content: pdfBuffer!.toString('base64'),
            caption: "Comprovante de pagamento",
            to: transaction.userId,
            reply: false,
            isError: false,
        };

        return [message];
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

    private async notifyWaiterPaymentMade(state: ConversationDto): Promise<ResponseStructureExtended[]> {
        const groupId = this.waiterGroupId;
        this.logger.log(`[notifyWaiterPaymentMade] Notificação de pagamento para o grupo: ${groupId}`);

        try {
            const { orderId, tableId, conversationContext: { userAmount }, userId } = state;

            const { data: orderData } = await this.orderService.getOrder(orderId);
            const isThereManyParticipants = orderData.splitInfo && orderData.splitInfo.numberOfPeople > 1;

            const totalAmount = orderData.totalAmount;
            const amountPaidSoFar = orderData.amountPaidSoFar || 0;
            const remainingAmount = totalAmount - amountPaidSoFar;

            let message = "";

            if (!isThereManyParticipants) {
                const { data: totalPaid } = await this.transactionService.getTotalPaidByUserAndOrderId(userId, orderId);
                const totalPaidByUser = totalPaid.totalPaid || 0;
                const userRemainingAmount = userAmount - totalPaidByUser;

                message += `*👋 Astra Pay* - STATUS Mesa ${tableId}\n\n`;
                message += `Divisão de pagamento: Não\n`;
                message += `Deveria pagar: R$ ${totalAmount.toFixed(2)}\n`;
                message += `Pagou: R$ ${totalPaidByUser.toFixed(2)}`;

                if (userRemainingAmount > 0) {
                    message += `\nRestante: R$ ${userRemainingAmount.toFixed(2)}`;
                } else if (userRemainingAmount < 0) {
                    message += `\nExcedente: R$ ${Math.abs(userRemainingAmount).toFixed(2)}`;
                }

                return this.mapTextMessages([message], groupId);
            }

            // Handling multiple participants
            const splitInfo = orderData.splitInfo;
            const numberOfPeople = splitInfo.numberOfPeople;
            const participants: ParticipantDTO[] = splitInfo.participants;

            message += `*👋 Astra Pay* - STATUS Mesa ${tableId}\n\n`;
            message += `Total: R$ ${totalAmount.toFixed(2)}\n\n`;
            message += `👥 Divisão entre ${numberOfPeople} pessoa${numberOfPeople > 1 ? 's' : ''}:\n\n`;

            participants.forEach(participant => {
                const { expectedAmount, paidAmount } = participant;
                let name = participant.name || 'Cliente';

                if (name.includes('@s.whatsapp.net')) {
                    name = 'Cliente';
                }

                let participantMessage = `*${name} - `;

                if (paidAmount >= expectedAmount) {
                    participantMessage += `Pago 🟢*\n\n`;
                } else {
                    const remaining = expectedAmount - paidAmount;
                    participantMessage += `Pendente 🟡*\nDeveria pagar: R$ ${expectedAmount.toFixed(2)}\nRestante: R$ ${remaining.toFixed(2)}\n\n`;
                }

                message += participantMessage;
            });

            message = message.trimEnd();

            this.logger.log(`[notifyWaiterPaymentMade] Mensagem de pagamento para o grupo: ${message}`);

            return this.mapTextMessages([message], groupId);
        } catch (error) {
            this.logger.error(`[notifyWaiterPaymentMade] Error: ${error}`);
            return [];
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

    private notifyWaiterAuthenticationStatus(message: string, state: ConversationDto): ResponseStructureExtended[] {
        const groupId = this.waiterGroupId;

        this.logger.log(`[notifyWaiterAuthenticationStatus] Notificação de status de autenticação: ${message}`);

        return this.mapTextMessages([message], groupId);
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

    private sendProofToGroup(mediaData: string, mediaType: string, state: ConversationDto): ResponseStructureExtended[] {
        const groupId = this.paymentProofGroupId;

        this.logger.log(`[sendProofToGroup] Enviando comprovante para o grupo: ${groupId}`);

        let fileName: string;
        let caption = 'Comprovante de pagamento';

        if (mediaType === 'application/pdf') {
            fileName = 'comprovante.pdf';
        } else if (mediaType.startsWith('image/')) {
            fileName = 'comprovante.jpg';
        } else {
            fileName = 'comprovante.bin';
        }

        return [
            {
                type: 'image',
                content: mediaData,
                caption: caption,
                to: groupId,
                reply: false,
                isError: false,
            }
        ];
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

    public notifyWaiterTableStartedPayment(tableNumber: number): ResponseStructureExtended[] {
        const groupId = this.waiterGroupId;

        this.logger.log(`[notifyWaiterTableStartedPayment] Notificação de início de pagamentos para a mesa ${tableNumber}`);

        const message = `👋 *Astra Pay* - A mesa ${tableNumber} iniciou o processo de pagamentos.`;
        return this.mapTextMessages([message], groupId);

    }

    private notifyRefundRequest(tableNumber: number, refundAmount: number): ResponseStructureExtended[] {
        const groupId = this.refundGroupId;

        this.logger.log(`[notifyRefundRequestToWaiter] Notificação de estorno para a mesa ${tableNumber}`);

        const message = `👋 *Astra Pay* - A mesa ${tableNumber} solicitou um estorno de *${formatToBRL(refundAmount)}*.`;
        return this.mapTextMessages([message], groupId);
    }

    public notifyWaiterWrongOrder(tableNumber: number): ResponseStructureExtended[] {
        const groupId = this.waiterGroupId;

        this.logger.log(`[notifyWaiterWrongOrder] Notificação de pedido errado para a mesa ${tableNumber}`);

        const message = `👋 *Astra Pay* - A Mesa ${tableNumber} relatou um problema com os pedidos da comanda.\n\nPor favor, dirija-se à mesa para verificar.`;
        return this.mapTextMessages([message], groupId);
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
    }): Promise<retryRequestResponse> {
        let attempts = 0;
        let sentMessages: ResponseStructureExtended[] = [];

        while (attempts < maxRetries) {
            try {
                const retryResponse = await requestFunction();

                const response: retryRequestResponse = {
                    response: retryResponse,
                    sentMessages: []
                };

                return response;
            } catch (error) {
                attempts++;
                this.logger.error(
                    `Attempt ${attempts} failed for user ${from} at stage ${state.conversationContext.currentStep}. Error: ${error}`
                );

                if (attempts === delayNotificationThreshold && sendDelayNotification) {
                    const delayMessage = this.getDelayMessage(state);
                    this.whatsappApi.sendWhatsAppMessages([delayMessage]);
                }

                if (attempts < maxRetries) {
                    await new Promise((resolve) => setTimeout(resolve, delayBetweenRetries));
                }

                const notifyAuthMessages = await this.notifyWaiterAuthenticationStatus(groupMessage, state);
                // this.whatsappApi.sendWhatsAppMessages(notifyAuthMessages);
            }
        }

        const errorMessage = this.generateStageErrorMessage(state);
        sentMessages.push(...this.mapTextMessages([errorMessage], from, true, false, true));

        const waiterErrorMessage = `👋 *Astra Pay* - Erro ao processar a Mesa ${state.tableId}.\n\nSe direcione para a mesa para verificar o problema.`;
        sentMessages.push(...this.mapTextMessages([waiterErrorMessage], this.waiterGroupId));

        const response: retryRequestResponse = {
            response: null,
            sentMessages,
        };

        this.logger.error(`[retryRequestWithNotification] Max retries reached for user ${from} at stage ${state.conversationContext.currentStep}. Error: ${errorMessage}`);
        return response;
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
        conversation: ConversationDto,
    ): ResponseStructureExtended {
        switch (conversation.conversationContext.currentStep) {
            case ConversationStep.ProcessingOrder:
                return {
                    type: 'text',
                    content: `🔄 O processamento da sua comanda está demorando um pouco mais que o esperado.\n\n Por favor, aguarde um instante enquanto verificamos os detalhes para você! 😊`,
                    to: conversation.userId,
                    reply: false,
                    isError: false,
                    caption: '',
                };

            case ConversationStep.ConfirmOrder:
                return {
                    type: 'text',
                    content: `🔄 Estamos confirmando os detalhes da sua comanda, mas parece que está demorando um pouco mais do que o habitual.\n\n Por favor, mantenha-se à vontade, logo finalizaremos! 😄`,
                    to: conversation.userId,
                    reply: false,
                    isError: false,
                    caption: '',
                };

            case ConversationStep.SplitBill:
                return {
                    type: 'text',
                    content: `🔄 O processo de divisão da conta está em andamento, mas pode levar alguns instantes a mais.\n\n Agradecemos pela paciência! 🎉`,
                    to: conversation.userId,
                    reply: false,
                    isError: false,
                    caption: '',
                };

            case ConversationStep.WaitingForContacts:
                return {
                    type: 'text',
                    content: `🔄 Estamos aguardando os contatos para dividir a conta.\n\n Isso pode demorar um pouco mais do que o esperado. Obrigado pela compreensão! 📲`,
                    to: conversation.userId,
                    reply: false,
                    isError: false,
                    caption: '',
                };

            case ConversationStep.WaitingForPayment:
                return {
                    type: 'text',
                    content: `🔄 Estamos aguardando a confirmação do pagamento. Pode levar alguns instantes.\n\n Agradecemos pela paciência! 🕒`,
                    to: conversation.userId,
                    reply: false,
                    isError: false,
                    caption: '',
                };

            default:
                const errorMessage = {
                    type: 'interactive',
                    content: '',
                    caption: '',
                    to: conversation.userId,
                    reply: false,
                    isError: true,
                    interactive: {
                        bodyText: 'Estamos enfrentando dificuldades técnicas para processar seu pagamento PIX. Por favor, tente novamente mais tarde.',
                        buttons: [
                            { id: 'try_again_later', title: 'Tentar Novamente' }
                        ],
                        headerType: 'text',
                        headerContent: 'Erro no Processamento',
                        footerText: 'Nossa equipe já foi notificada.'
                    }
                };

                return errorMessage as ResponseStructureExtended;
        }
    }


    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Retorna o timestamp atual no formato HORA:MINUTO (24 horas).
     */
    private getCurrentTime(): string {
        const now = new Date();
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        return `${hours}:${minutes}`;
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

    private generateStageErrorMessage(conversation: ConversationDto): string {
        const currentStep = conversation.conversationContext.currentStep;
        switch (currentStep) {
            case ConversationStep.ProcessingOrder:
                this.notifyWaiterAuthenticationStatus(GroupMessages[GroupMessageKeys.ORDER_PROCESSING_ERROR](conversation.tableId), conversation);
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
            state.conversationContext.splitInfo = { numberOfPeople: 1, participants: [] };
        }

        const numPeople = state.conversationContext.splitInfo.numberOfPeople || 1;
        return this.formatToTwoDecimalPlaces(totalAmount / numPeople);
    }

    private formatToTwoDecimalPlaces(value: number): number {
        return Math.floor(value * 100) / 100;
    }


    async processReceipt(file: Express.Multer.File, transactionId: string): Promise<string> {
        this.logger.log(`[processReceipt] Iniciando processamento do comprovante para a transação ${transactionId}`);
        this.logger.log(`[processReceipt] Arquivo enviado: ${file}`);
        if (!file) {
            throw new HttpException('Nenhum arquivo enviado', HttpStatus.BAD_REQUEST);
        }
        if (!transactionId) {
            throw new HttpException('TransactionId é obrigatório', HttpStatus.BAD_REQUEST);
        }

        const base64Image = file.buffer.toString('base64');

        const transactionResponse = await this.transactionService.getTransaction(transactionId);
        const transaction = transactionResponse.data;
        if (!transaction || !transaction.userId) {
            throw new HttpException('Transação não encontrada ou sem informação de usuário', HttpStatus.NOT_FOUND);
        }

        const receiptMessage: ResponseStructureExtended = {
            type: 'image',
            content: base64Image,
            caption: 'Seu comprovante de pagamento',
            to: transaction.userId,
            reply: false,
            isError: false,
        };

        await this.sendMessagesDirectly([receiptMessage]);

        return 'Comprovante enviado com sucesso para o usuário';
    }

    getStepReminderMessage(step: ConversationStep): string {
        const stepMessages: Partial<Record<ConversationStep, string>> = {
            [ConversationStep.CollectName]: 'Notamos que você ainda não nos deu seu *Nome Completo* para continuarmos seu pagamento.',
            [ConversationStep.ProcessingOrder]: 'Estamos processando seu pedido. Por favor, aguarde um momento.',
            [ConversationStep.ConfirmOrder]: 'Notamos que você ainda não confirmou seu pedido. Ele está correto?\n\n1- Sim 2- Não',
            [ConversationStep.SplitBill]: 'Estamos aguardando a confirmação da divisão da conta.',
            [ConversationStep.WaitingForContacts]: 'Estamos aguardando os contatos para dividir a conta.',
            [ConversationStep.ExtraTip]: 'Gostaria de adicionar uma gorjeta extra?',
            [ConversationStep.CollectCPF]: 'Notamos que você ainda não nos deu seu CPF para continuarmos o pagamento.',
            [ConversationStep.PixExpired]: 'Seu PIX expirou. Gostaria de gerar um novo?\n\n1- Sim 2- Não',
            [ConversationStep.PaymentMethodSelection]: 'Por favor, escolha um método de pagamento para continuar.',
            // [ConversationStep.WaitingForPayment]: 'Estamos aguardando a confirmação do pagamento.',
            // [ConversationStep.Feedback]: 'Notamos que você ainda não nos deu seu Feedback. Queremos saber como foi sua experiência.',
            // [ConversationStep.FeedbackDetail]: 'Poderia nos dar mais detalhes sobre seu feedback?',
        };

        return stepMessages[step] || 'Estamos aguardando sua ação para continuar.';
    }

    private async handlePIXError(
        from: string,
        userMessage: string,
        state: ConversationDto
    ): Promise<ResponseStructureExtended[]> {
        const sentMessages: ResponseStructureExtended[] = [];

        const tryAgainBtn = this.whatsappApi.createInteractiveButtonMessage(
            from,
            'Houve um erro na geração do PIX. Deseja tentar novamente?',
            [
                { id: 'retry_pix_generation', title: 'Tentar Novamente' }
            ],
            {
                headerType: 'text',
                headerContent: 'Erro na Geração do PIX',
                footerText: ''
            }
        );

        await this.conversationService.updateConversation(state._id.toString(), {
            userId: state.userId,
            conversationContext: {
                ...state.conversationContext,
                currentStep: ConversationStep.WaitingForPayment,
            },
        });

        sentMessages.push(tryAgainBtn);

        return sentMessages;
    }

    private async handleWaitingForPayment(
        from: string,
        userMessage: string,
        state: ConversationDto
    ): Promise<ResponseStructureExtended[]> {
        const sentMessages: ResponseStructureExtended[] = [];
        const conversationId = state._id.toString();
        const normalizedMessage = userMessage.trim().toLowerCase();

        // Check for button interactions or text equivalents
        const isRetry = normalizedMessage === 'sim' || normalizedMessage.includes('tentar novamente') || userMessage.startsWith('button_payment_pix:');
        const isBackToStart = ['não', 'nao', 'n', 'nn', 'voltar para o início'].some(keyword => normalizedMessage.includes(keyword)) || userMessage.startsWith('button_no_back_to_start:');

        if (isRetry) {
            // Retry PIX generation
            const updatedContext: ConversationContextDTO = {
                ...state.conversationContext,
                currentStep: ConversationStep.CollectName, // Go back to CollectName to retry
            };

            await this.conversationService.updateConversation(conversationId, {
                userId: state.userId,
                conversationContext: updatedContext,
            });

            sentMessages.push(
                ...this.mapTextMessages(['Por favor, informe seu nome novamente para tentarmos gerar o PIX.'], from)
            );
        } else if (isBackToStart) {
            // Reset conversation to start
            const updatedContext: ConversationContextDTO = {
                ...state.conversationContext,
                currentStep: ConversationStep.PIXError
            };

            await this.conversationService.updateConversation(conversationId, {
                userId: state.userId,
                conversationContext: updatedContext,
            });

            sentMessages.push(
                ...this.mapTextMessages(['Você foi redirecionado para o início. Como posso ajudar?'], from)
            );
        } else {
            // Unrecognized input, resend the options
            const paymentMethodMessage = this.whatsappApi.createInteractiveButtonMessage(
                from,
                'Houve um erro na geração do PIX. Deseja tentar novamente?',
                [
                    { id: "payment_pix", title: "Tentar Novamente" },
                    { id: "no_back_to_start", title: "Não, voltar para o início" }
                ],
                {
                    headerType: "text",
                    headerContent: "Erro no Pagamento",
                    footerText: ""
                }
            );

            sentMessages.push(paymentMethodMessage);
        }

        return sentMessages;
    }
}