import { Injectable, OnModuleInit, Logger, Inject, HttpException, HttpStatus } from '@nestjs/common';
import WAWebJS, { Client, CreateGroupResult, LocalAuth, Message, MessageMedia } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import { TableService } from 'src/table/table.service';
import {
    BaseConversationDto,
    ConversationContextDTO,
    ConversationDto,
    CreateConversationDto,
    FeedbackDTO,
    MessageDTO,
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
import { CreateTransactionDTO, PaymentMethod, PaymentProofDTO, TransactionDTO } from 'src/transaction/dto/transaction.dto';
import { GroupMessageKeys, GroupMessages } from './utils/group.messages.utils';
import { WhatsAppUtils } from './whatsapp.utils';
import { PaymentProcessorDTO } from './payment.processor';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { CreateWhatsAppGroupDTO, WhatsAppGroupDTO, WhatsAppParticipantsDTO } from './dto/whatsapp.dto';
import { Db, ObjectId } from 'mongodb';
import { ClientProvider } from 'src/db/db.module';
import { SimpleResponseDto } from 'src/request/request.dto';
import { isError } from 'util';
import { UserPaymentPixInfoDto } from 'src/payment-gateway/dto/ipag-pagamentos.dto';
import { IPagService } from 'src/payment-gateway/ipag.service';

// Resposta para um Request do GO
//[{
// "type": image or text,
// "content": "string", (text or byte array)
// "caption": "string",
// "to": "string",
// "reply": boolean, (always the same as array and to the same as from)
// },{
// "type": image or text,
// "content": "string", (text or byte array)
// "caption": "string",
// "to": "string",
// "reply": boolean, (always the same as array and to the same as from)
// }] 

interface SendMessageParams {
    from: string;
    messages: string[];
    state: ConversationDto;
    delay?: number;
    toAttendants?: boolean;
    media?: MessageMedia;
    caption?: string;
}

export interface RequestStructure {
    from: string;
    type: "image" | "text" | "vcard";
    content: string;
}

export interface ResponseStructure {
    type: "image" | "text";
    content: string;
    caption: string;
    to: string;
    reply: boolean;
}

export interface ResponseStructureExtended extends ResponseStructure {
    isError: boolean;
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
export class WhatsAppService {
    private readonly logger = new Logger(WhatsAppService.name);

    private readonly waiterGroupId = process.env.ENVIRONMENT === 'homologation' ? process.env.WAITER_HOM_GROUP_ID : process.env.ENVIRONMENT === 'production' ? process.env.WAITER_PROD_GROUP_ID : process.env.WAITER_DEV_GROUP_ID;
    private readonly paymentProofGroupId = process.env.ENVIRONMENT === 'homologation' ? process.env.PAYMENT_PROOF_HOM_GROUP_ID : process.env.ENVIRONMENT === 'production' ? process.env.PAYMENT_PROOF_PROD_GROUP_ID : process.env.PAYMENT_PROOF_DEV_GROUP_ID;
    private readonly refundGroupId = process.env.ENVIRONMENT === 'homologation' ? process.env.REFUND_HOM_GROUP_ID : process.env.ENVIRONMENT === 'production' ? process.env.REFUND_PROD_GROUP_ID : process.env.REFUND_DEV_GROUP_ID;

    constructor(
        private readonly tableService: TableService,
        private readonly userService: UserService,
        private readonly conversationService: ConversationService,
        private readonly orderService: OrderService,
        private readonly transactionService: TransactionService,
        private readonly utilsService: WhatsAppUtils,
        private readonly ipagService: IPagService,
        @InjectQueue('payment') private readonly paymentQueue: Queue,
        @Inject('DATABASE_CONNECTION') private db: Db, clientProvider: ClientProvider
    ) { }

    public async handleProcessMessage(request: RequestStructure): Promise<ResponseStructureExtended[]> {
        const fromPerson = request.from;

        const message: RequestMessage = {
            from: fromPerson,
            body: request.content,
            timestamp: Math.floor(Date.now() / 1000),
            type: request.type,
        };

        // Calculate message age to avoid processing old messages
        const currentTime = Math.floor(Date.now() / 1000); // current time in seconds
        const messageAge = currentTime - message.timestamp; // message timestamp is in seconds
        const maxAllowedAge = 30; // 30 seconds

        if (messageAge > maxAllowedAge) {
            this.logger.debug(`Ignoring old message from ${message.from}: ${message.body}`);
            return; // Ignore old messagese
        }

        const from = message.from;

        // Handle incoming message and manage conversation state
        await this.handleIncomingMessage(from);

        // Retrieve the user
        let user = await this.userService.getUser(from).catch(() => null);
        if (!user) {
            this.logger.error(`User ${from} not found after handleIncomingMessage`);
            return;
        }

        // Retrieve the active conversation
        const activeConversationResponse = await this.conversationService.getActiveConversation(from);
        const state = activeConversationResponse.data;

        let requestResponse: ResponseStructureExtended[] = [];

        if (!state) {
            this.logger.debug(`No active conversation for user ${from}`);
            requestResponse.push({
                type: "text",
                content: "Desculpe, não entendi sua solicitação. Se você gostaria de pagar uma comanda, por favor, use a frase 'Gostaria de pagar a comanda X'.",
                caption: "",
                to: from,
                reply: true,
                isError: false,
            });
            return;
        }

        const userMessage = message.body.trim().toLowerCase();

        // Log current state for debugging
        // this.logger.debug(
        //     `User: ${from}, State: ${state.conversationContext.currentStep}, Message: "${userMessage}"`,
        // );

        // Handle conversation steps
        switch (state.conversationContext.currentStep) {
            case ConversationStep.ProcessingOrder:
                if (userMessage.toLowerCase().includes('pagar a comanda')) {
                    state.conversationContext.currentStep = ConversationStep.Initial;
                    requestResponse = await this.handleOrderProcessing(from, userMessage, state, message);
                }
                break;

            case ConversationStep.ConfirmOrder:
                requestResponse = await this.handleConfirmOrder(from, userMessage, state);
                break;

            case ConversationStep.SplitBill:
                requestResponse = await this.handleSplitBill(from, userMessage, state);
                break;

            case ConversationStep.SplitBillNumber:
                requestResponse = await this.handleSplitBillNumber(from, userMessage, state);
                break;

            case ConversationStep.WaitingForContacts:
                requestResponse = await this.handleWaitingForContacts(from, state, message);
                break;

            case ConversationStep.ExtraTip:
                requestResponse = await this.handleExtraTip(from, userMessage, state);
                break;

            case ConversationStep.CollectCPF:
                requestResponse = await this.handleCollectCPF(from, userMessage, state);
                break;

            case ConversationStep.PaymentMethodSelection:
                requestResponse = await this.handlePaymentMethodSelection(from, userMessage, state);
                break;

            case ConversationStep.CollectName:
                requestResponse = await this.handleCollectName(from, userMessage, state);
                break;

            case ConversationStep.Feedback:
                requestResponse = await this.handleFeedback(from, userMessage, state);
                break;

            case ConversationStep.FeedbackDetail:
                requestResponse = await this.handleFeedbackDetail(from, userMessage, state);
                break;

            case ConversationStep.Completed:
                // Conversation completed; no action needed
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
    };


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

        const activeConversationResponse = await this.conversationService
            .getActiveConversation(userId)
            .catch(() => null);

        if (!activeConversationResponse?.data) {
            const newConversation: CreateConversationDto = {
                userId,
                conversationContext: {
                    currentStep: ConversationStep.Initial,
                    messages: [],
                    lastMessage: new Date(),
                },
            };
            await this.conversationService.createConversation(newConversation);
        }
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
                        '*👋 Coti Pagamentos* – Bem-vindo(a)!\nTornamos o seu pagamento prático e sem complicações.\n\nMétodos Aceitos:\n- PIX\n- Cartão de Crédito (em breve!)',
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
                        '*👋 Coti Pagamentos* – Bem-vindo(a)!\nTornamos o seu pagamento prático e sem complicações.\n\nMétodos Aceitos:\n- PIX\n- Cartão de Crédito (em breve!)',
                    ],
                    from,
                    true,
                ),
            );

            const processingMessages = await this.handleProcessingOrder(from, state, tableIdInt);
            sentMessages.push(...processingMessages);

            return sentMessages;
        }

        // Se outra pessoa já está processando a comanda, verifique se ela está na fase de divisão.
        const step = otherState?.conversationContext?.currentStep;
        const splittingSteps = [
            ConversationStep.SplitBill,
            ConversationStep.SplitBillNumber,
            ConversationStep.WaitingForContacts,
        ];

        if (step && splittingSteps.includes(step)) {
            // Apenas notifica que a comanda está em divisão.
            sentMessages.push(
                ...this.mapTextMessages(
                    [
                        '*👋 Coti Pagamentos* - A comanda está sendo dividida. Aguarde a finalização para continuar.',
                    ],
                    from,
                    true,
                ),
            );
        } else {
            sentMessages.push(
                ...this.mapTextMessages(
                    ['Desculpe, esta comanda já está sendo processada por outra pessoa.'],
                    from,
                    true,
                ),
            );
        }

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
                        ['*👋 Coti Pagamentos* - Não há pedidos cadastrados em sua comanda. Por favor, tente novamente mais tarde.'],
                        from,
                        true,
                        false,
                        true,
                    ),
                );
                return sentMessages;
            }


            const orderData = retryResponse.response;

            const orderMessage = orderData.message;
            const orderDetails = orderData.details;

            // Adiciona as mensagens de resposta
            sentMessages.push(
                ...this.mapTextMessages(
                    [orderMessage, '👍 A sua comanda está correta?\n\n1- Sim\n2- Não'],
                    from,
                ),
            );

            // Cria a ordem do pedido
            const createOrderData: CreateOrderDTO = {
                tableId,
                items: orderDetails.orders,
                totalAmount: orderDetails.total,
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

    private mapTextMessages(messages: string[], to: string, reply: boolean = false, toGroup: boolean = false, isError: boolean = false): ResponseStructureExtended[] {
        return messages.map((message) => {
            const content = toGroup ? `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\n${message}` : message;
            return {
                type: 'text' as 'text',
                content,
                caption: '',
                to,
                reply: reply,
                isError: isError,
            };
        });
    }


    private async handleConfirmOrder(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<ResponseStructureExtended[]> {
        const sentMessages: ResponseStructureExtended[] = [];
        const positiveResponses = ['1', 'sim', 'correta', 'está correta', 'sim está correta'];
        const negativeResponses = ['2', 'não', 'nao', 'não está correta', 'incorreta', 'não correta'];

        const updatedContext: ConversationContextDTO = { ...state.conversationContext };

        const tableId = parseInt(state.tableId, 10);

        if (positiveResponses.some((response) => userMessage.includes(response))) {

            const notifyWaiterMessages = this.notifyWaiterTableStartedPayment(tableId);

            sentMessages.push(
                ...this.mapTextMessages(
                    [
                        '👍 Você gostaria de dividir a conta?\n\n1- Não\n2- Sim, em partes iguais',
                    ],
                    from,
                ),
                ...notifyWaiterMessages,
            );
            this.retryRequestWithNotification({
                from,
                requestFunction: () => this.tableService.startPayment(tableId),
                state,
                sendDelayNotification: false,
                groupMessage: GroupMessages[GroupMessageKeys.PREBILL_ERROR](state.tableId),
            });


            updatedContext.currentStep = ConversationStep.SplitBill;

        } else if (negativeResponses.some((response) => userMessage.includes(response))) {
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
            sentMessages.push(
                ...this.mapTextMessages(
                    ['Por favor, responda com *1 para Sim* ou *2 para Não*.'],
                    from,
                ),
            );
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
            phone: state.userId,
            expectedAmount: individualAmount,
            paidAmount: 0,
        });

        const splitInfo: SplitInfoDTO = {
            numberOfPeople: state.conversationContext.splitInfo.numberOfPeople,
            participants: contacts.map((contact) => ({
                name: contact.name,
                phone: contact.phone,
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
                `*👋 Coti Pagamentos* - Olá! Você foi incluído na divisão do pagamento da comanda *${state.tableId}* no restaurante Cris Parrilla.`,
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
            'Por favor, nos informe o seu CPF para a emissão da nota fiscal. 😊'
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
                ['Por favor, nos informe o seu CPF para a emissão da nota fiscal. 😊'],
                from
            ),
        );

        // Atualiza o contexto para coletar o CPF em seguida
        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            currentStep: ConversationStep.CollectCPF,
            userAmount: totalAmountWithTip,
            tipAmount: totalAmountWithTip - userAmount,
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
        const messages = [
            'Por favor, escolha uma das opções de gorjeta: 3%, 5% ou 7%, ou diga que não deseja dar gorjeta.',
        ];

        return this.mapTextMessages(messages, from);
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

        // Validação do CPF (mesmo código que você já tem)
        const cpfLimpo = userMessage.replace(/\D/g, '');
        if (cpfLimpo.length !== 11 || !this.isValidCPF(cpfLimpo)) {
            sentMessages = await this.handleInvalidCPF(from, state);
            return sentMessages;
        }

        // Atualiza o contexto para direcionar o usuário à escolha do método de pagamento
        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            currentStep: ConversationStep.PaymentMethodSelection,
            paymentStartTime: Date.now(),
            cpf: cpfLimpo,
        };

        await this.conversationService.updateConversation(conversationId, {
            userId: state.userId,
            conversationContext: updatedContext,
        });

        sentMessages.push(...this.mapTextMessages(
            ['👍 Escolha a forma de pagamento:\n\n1- PIX\n2- Cartão de Crédito'],
            from
        ));

        return sentMessages;
    }


    /**
     * Função para lidar com CPF inválido.
     */
    private async handleInvalidCPF(from: string, state: ConversationDto): Promise<ResponseStructureExtended[]> {
        const messages = ['Por favor, informe um CPF válido com 11 dígitos. 🧐'];
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
            'Por favor, envie o comprovante! 📄✅'
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


    private async createTransaction(state: ConversationDto, paymentMethod: PaymentMethod, userName: string): Promise<{ transactionResponse: TransactionDTO, pixKey: string }> {

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
                    cpf_cnpj: state.conversationContext.cpf,
                }
            };

            const ipagResponse = await this.ipagService.createPIXPayment(userPaymentInfo);
            const ipagTransactionId = ipagResponse.uuid;
            const pixKey = ipagResponse.attributes.pix.qrcode;

            await this.transactionService.updateTransaction(transactionId, { ipagTransactionId });

            return { transactionResponse: transactionResponse.data, pixKey };
        }

        return { transactionResponse: transactionResponse.data, pixKey: null };
    }



    private async handlePaymentMethodSelection(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<ResponseStructureExtended[]> {
        let sentMessages: ResponseStructureExtended[] = [];
        const conversationId = state._id.toString();
        const userChoice = userMessage.trim().toLowerCase();

        if (userChoice === '1' || userChoice.includes('pix')) {
            // Atualiza o contexto para PIX e redireciona para a coleta do nome
            const updatedContext: ConversationContextDTO = {
                ...state.conversationContext,
                currentStep: ConversationStep.CollectName, // novo passo para coletar o nome
                paymentMethod: PaymentMethod.PIX,
            };

            await this.conversationService.updateConversation(conversationId, {
                userId: state.userId,
                conversationContext: updatedContext,
            });

            // Solicita que o usuário informe seu nome completo
            sentMessages.push(
                ...this.mapTextMessages(
                    ['Por favor, informe seu nome completo para prosseguirmos com o pagamento via PIX.'],
                    from
                )
            );
        } else if (userChoice === '2' || userChoice.includes('cartão') || userChoice.includes('crédito')) {
            // Fluxo existente para Cartão de Crédito
            const updatedContext: ConversationContextDTO = {
                ...state.conversationContext,
                currentStep: ConversationStep.WaitingForPayment,
                paymentMethod: PaymentMethod.CREDIT_CARD,
            };

            await this.conversationService.updateConversation(conversationId, {
                userId: state.userId,
                conversationContext: updatedContext,
            });

            // Cria a transação utilizando o método Cartão de Crédito
            const transactionResponse = await this.createTransaction(state, PaymentMethod.CREDIT_CARD, state.conversationContext.userName);


            this.logger.log(`[handlePaymentMethodSelection] transactionResponse: ${transactionResponse.transactionResponse._id}`);
            sentMessages = await this.handleCreditCardPayment(from, state, transactionResponse.transactionResponse);

        } else {
            // Resposta inválida; solicita nova escolha
            sentMessages.push(
                ...this.mapTextMessages(
                    ['Opção inválida. Por favor, escolha:\n1- PIX\n2- Cartão de Crédito'],
                    from
                )
            );
        }

        return sentMessages;
    }

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

        // Cria a transação utilizando o método PIX agora que temos o nome e captura o PIX key
        const transactionResponse = await this.createTransaction(state, PaymentMethod.PIX, name);

        // Envia as instruções de pagamento via PIX utilizando o PIX key retornado
        if (transactionResponse.pixKey) {
            const paymentMessages = await this.handlePIXPaymentInstructions(from, state, transactionResponse.pixKey);
            sentMessages.push(...paymentMessages);
        }

        return sentMessages;
    }


    private async handleCreditCardPayment(
        from: string,
        state: ConversationDto,
        transactionResponse: TransactionDTO
    ): Promise<ResponseStructureExtended[]> {
        let sentMessages: ResponseStructureExtended[] = [];
        // Aqui você pode obter o link de pagamento do gateway (por exemplo, de uma variável de ambiente)
        const paymentLink = `${process.env.CREDIT_CARD_PAYMENT_LINK}?transactionId=${transactionResponse._id}`;
        this.logger.log(`[handleCreditCardPayment] paymentLink: ${paymentLink}`);

        // Envia uma mensagem com o link de pagamento
        sentMessages.push(...this.mapTextMessages(
            [
                `O valor final da conta é de *${formatToBRL(state.conversationContext.userAmount)}*.`,
                `*Clique no link abaixo* para realizar o pagamento com Cartão de Crédito:`,
                paymentLink,
                `*Importante:* Não consegue clicar no link?\n\n*Salve* nosso contato na agenda.\nOu copie e cole em seu navegador.`
            ],
            from
        ));



        // Atualiza o estado da conversa, se necessário (ex.: permanecer no WaitingForPayment aguardando o comprovante)
        const conversationId = state._id.toString();
        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            currentStep: ConversationStep.WaitingForPayment,
        };

        await this.conversationService.updateConversation(conversationId, {
            userId: state.userId,
            conversationContext: updatedContext,
        });

        return sentMessages;
    }

    public async processPayment(paymentData: PaymentProcessorDTO): Promise<void> {
        const { transactionId, from, state } = paymentData;
        this.logger.debug(
            `[processPayment] Processing payment, transactionId: ${transactionId}`
        );

        let sentMessages: ResponseStructureExtended[] = [];
        const transaction = await this.transactionService.getTransaction(transactionId);

        if (transaction.data.status !== PaymentStatus.Confirmed) {
            sentMessages.push(
                ...this.mapTextMessages(
                    ['*👋  Coti Pagamentos* - Erro ao processar o pagamento ❌\n\nPor favor, tente novamente mais tarde.'],
                    from
                )
            );
        } else {
            sentMessages.push(
                ...this.mapTextMessages(
                    [
                        '*👋  Coti Pagamentos* - Pagamento Confirmado ✅\n\nEsperamos que sua experiência tenha sido excelente.',
                        'Como você se sentiria se não pudesse mais usar o nosso serviço?\n\nEscolha uma das opções abaixo',
                        '1- Muito decepcionado\n2- Um pouco decepcionado\n3- Não faria diferença',
                    ],
                    from
                )
            );
            // Atualiza o estado da conversa para iniciar a etapa de Feedback
            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: {
                    ...state.conversationContext,
                    currentStep: ConversationStep.Feedback,
                },
            });

            // Finaliza o pagamento na mesa
            const tableId = parseInt(state.tableId, 10);
            await this.tableService.finishPayment(tableId);

            // Notifica os atendentes que a mesa pagou com sucesso
            const notifyWaiterMessages = await this.notifyWaiterTablePaymentComplete(state);
            sentMessages.push(...notifyWaiterMessages);
        }

        // Envia as mensagens para o bot GO (que está ouvindo na porta 3105)
        const goBotUrl = process.env.GO_BOT_URL || "http://localhost:3105/send-messages";
        try {
            const response = await fetch(goBotUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(sentMessages),
            });
            if (!response.ok) {
                const errText = await response.text();
                this.logger.error(`Falha ao enviar mensagens para o bot GO. Status: ${response.status}, erro: ${errText}`);
            } else {
                this.logger.debug("Mensagens enviadas com sucesso para o bot GO.");
            }
        } catch (error) {
            this.logger.error(`Erro ao enviar mensagens para o bot GO: ${error.message}`);
        }
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

        if (typeof feedback.mustHaveScore === 'undefined') {
            const userResponse = userMessage.trim().toLowerCase();
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
            };

            // Verifica se a resposta do usuário é válida
            const matchedOption = Object.keys(validOptions).find(
                (key) => key === userResponse || userResponse.includes(key)
            );

            if (!matchedOption) {
                sentMessages = this.mapTextMessages(
                    [
                        'Por favor, escolha uma das opções abaixo e envie apenas o número ou a descrição correspondente:',
                        '1- Muito decepcionado\n2- Um pouco decepcionado\n3- Não faria diferença',
                    ],
                    from
                );
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

            updatedContext.currentStep = ConversationStep.Completed;
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
                sentMessages = this.mapTextMessages(
                    [
                        'Obrigado pelo seu feedback detalhado!',
                        'Em quais outros restaurantes você gostaria de pagar na mesa com a Coti?',
                    ],
                    from
                );

                await this.conversationService.updateConversation(conversationId, {
                    userId: state.userId,
                    conversationContext: {
                        ...state.conversationContext,
                        currentStep: ConversationStep.FeedbackDetail,
                    },
                });
            } else {
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
            const recommended = userMessage.trim();
            if (!recommended) {
                sentMessages = this.mapTextMessages(
                    ['Por favor, conte em quais outros restaurantes você gostaria de usar a Coti.'],
                    from
                );

                await this.conversationService.updateConversation(conversationId, {
                    userId: state.userId,
                    conversationContext: {
                        ...state.conversationContext,
                        currentStep: ConversationStep.FeedbackDetail,
                    },
                });
            } else {
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


    private async notifyWaiterTableSplit(state: ConversationDto): Promise<ResponseStructureExtended[]> {
        const groupId = this.waiterGroupId;
        const message = `👋 Coti Pagamentos - Mesa ${state.tableId} irá compartilhar o pagamento`;

        return this.mapTextMessages([message], groupId);
    }

    private async notifyWaiterTablePaymentComplete(state: ConversationDto): Promise<ResponseStructureExtended[]> {
        const groupId = this.waiterGroupId;

        try {
            const { orderId, tableId } = state;
            const { data: orderData } = await this.orderService.getOrder(orderId);
            const { totalAmount, amountPaidSoFar = 0 } = orderData;

            const extraTip = amountPaidSoFar - totalAmount;
            let tipMessage = '';

            if (extraTip > 0) {
                tipMessage = extraTip > 15
                    ? `MAIS R$ ${extraTip.toFixed(2)} de Gorjeta 🎉`
                    : `MAIS ${((extraTip / totalAmount) * 100).toFixed(2)}% de Gorjeta 🎉`;
            }

            const message = tipMessage
                ? `*👋 Coti Pagamentos* - ${tipMessage}\n\nA mesa ${tableId} pagou com sucesso 🚀`
                : `*👋 Coti Pagamentos* - Mesa ${tableId} pagou com sucesso 🚀`;

            return this.mapTextMessages([message], groupId);
        } catch (error) {
            this.logger.error(`[notifyWaiterTablePaymentComplete] Error: ${error}`);
            return [];
        }
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

                message += `*👋 Coti Pagamentos* - STATUS Mesa ${tableId}\n\n`;
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

            message += `*👋 Coti Pagamentos* - STATUS Mesa ${tableId}\n\n`;
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

    private notifyWaiterTableStartedPayment(tableNumber: number): ResponseStructureExtended[] {
        const groupId = this.waiterGroupId;

        this.logger.log(`[notifyWaiterTableStartedPayment] Notificação de início de pagamentos para a mesa ${tableNumber}`);

        const message = `👋 *Coti Pagamentos* - A mesa ${tableNumber} iniciou o processo de pagamentos.`;
        return this.mapTextMessages([message], groupId);

    }

    private notifyRefundRequest(tableNumber: number, refundAmount: number): ResponseStructureExtended[] {
        const groupId = this.refundGroupId;

        this.logger.log(`[notifyRefundRequestToWaiter] Notificação de estorno para a mesa ${tableNumber}`);

        const message = `👋 *Coti Pagamentos* - A mesa ${tableNumber} solicitou um estorno de *${formatToBRL(refundAmount)}*.`;
        return this.mapTextMessages([message], groupId);
    }

    private notifyWaiterWrongOrder(tableNumber: number): ResponseStructureExtended[] {
        const groupId = this.waiterGroupId;

        this.logger.log(`[notifyWaiterWrongOrder] Notificação de pedido errado para a mesa ${tableNumber}`);

        const message = `👋 *Coti Pagamentos* - A Mesa ${tableNumber} relatou um problema com os pedidos da comanda.\n\nPor favor, dirija-se à mesa para verificar.`;
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

                // if (attempts === delayNotificationThreshold && sendDelayNotification) {
                //     const delayMessage = this.getDelayMessage(state.conversationContext.currentStep);
                //     sentMessages.push(...this.mapTextMessages([delayMessage], from));
                // }

                if (attempts < maxRetries) {
                    await new Promise((resolve) => setTimeout(resolve, delayBetweenRetries));
                }

                // const notifyAuthMessages = await this.notifyWaiterAuthenticationStatus(groupMessage, state);
                // sentMessages.push(...notifyAuthMessages);
            }
        }

        const errorMessage = this.generateStageErrorMessage(state);
        sentMessages.push(...this.mapTextMessages([errorMessage], from, true, false, true));

        const waiterErrorMessage = `👋 *Coti Pagamentos* - Erro ao processar a Mesa ${state.tableId}.\n\nSe direcione para a mesa para verificar o problema.`;
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

}

