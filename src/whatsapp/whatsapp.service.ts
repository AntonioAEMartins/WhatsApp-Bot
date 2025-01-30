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
import { CreateTransactionDTO, PaymentProofDTO, TransactionDTO } from 'src/transaction/dto/transaction.dto';
import { GroupMessageKeys, GroupMessages } from './utils/group.messages.utils';
import { WhatsAppUtils } from './whatsapp.utils';
import { PaymentProcessorDTO } from './payment.processor';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { CreateWhatsAppGroupDTO, WhatsAppGroupDTO, WhatsAppParticipantsDTO } from './dto/whatsapp.dto';
import { Db, ObjectId } from 'mongodb';
import { ClientProvider } from 'src/db/db.module';
import { SimpleResponseDto } from 'src/request/request.dto';

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

export interface RequestMessage {
    from: string;
    body: string;
    timestamp: number;
    type: string;
}

@Injectable()
export class WhatsAppService {
    private readonly logger = new Logger(WhatsAppService.name);
    private debugMode = process.env.DEBUG === 'true';

    constructor(
        private readonly tableService: TableService,
        private readonly userService: UserService,
        private readonly conversationService: ConversationService,
        private readonly orderService: OrderService,
        private readonly transactionService: TransactionService,
        private readonly utilsService: WhatsAppUtils,
        @InjectQueue('payment') private readonly paymentQueue: Queue,
        @Inject('DATABASE_CONNECTION') private db: Db, clientProvider: ClientProvider
    ) { }

    // public async createGroup(createGroupData: CreateWhatsAppGroupDTO): Promise<SimpleResponseDto<WhatsAppGroupDTO>> {

    //     const { title, participants } = createGroupData;

    //     if (!this.client) {
    //         throw new HttpException('WhatsApp client not initialized', HttpStatus.INTERNAL_SERVER_ERROR);
    //     }

    //     if (!title) {
    //         throw new HttpException('Invalid group creation parameters', HttpStatus.BAD_REQUEST);
    //     }

    //     participants.forEach((participant, index) => {
    //         if (!participant.includes('@c.us')) {
    //             participants[index] = `${participant}@c.us`;
    //         }
    //     });

    //     let result: CreateGroupResult | string;
    //     try {
    //         result = await this.client.createGroup(title, participants);
    //     } catch {
    //         throw new HttpException('Error creating group on WhatsApp', HttpStatus.INTERNAL_SERVER_ERROR);
    //     }

    //     if (typeof result === 'string') {
    //         throw new HttpException(result, HttpStatus.INTERNAL_SERVER_ERROR);
    //     }

    //     const group = result;

    //     const groupParticipants: WhatsAppParticipantsDTO[] = [];
    //     for (const participantId in group.participants) {
    //         if (Object.prototype.hasOwnProperty.call(group.participants, participantId)) {
    //             const p = group.participants[participantId];
    //             groupParticipants.push({
    //                 id: participantId,
    //                 statusCode: p.statusCode,
    //                 message: p.message,
    //                 isGroupCreator: p.isGroupCreator,
    //                 isInviteV4Sent: p.isInviteV4Sent,
    //             });
    //         }
    //     }

    //     const groupData: WhatsAppGroupDTO = {
    //         _id: new ObjectId(),
    //         title: group.title,
    //         gid: {
    //             server: group.gid.server,
    //             user: group.gid.user,
    //             _serialized: group.gid._serialized,
    //         },
    //         participants: groupParticipants,
    //         type: createGroupData.type,
    //     };

    //     try {
    //         await this.db.collection("groups").insertOne(groupData);
    //     } catch {
    //         throw new HttpException('Error saving group data to database', HttpStatus.INTERNAL_SERVER_ERROR);
    //     }

    //     return {
    //         msg: "Group created",
    //         data: groupData,
    //     };
    // }

    public async handleProcessMessage(request: RequestStructure): Promise<ResponseStructure[]> {
        const fromPerson = request.from;

        this.logger.debug(`Received message from ${fromPerson}: ${request.content}`);

        const message: RequestMessage = {
            from: fromPerson,
            body: request.content,
            timestamp: Math.floor(Date.now() / 1000),
            type: request.type,
        };

        // Ignore messages sent by the bot itself
        // if (fromPerson === "551132803247@s.whatsapp.net") {
        //     this.logger.debug(`Ignoring message from bot: ${message.body}`);
        //     return [];
        // }

        // Ignore messages from groups
        // if (message.from.includes('@g.us')) {
        //     this.logger.debug(`Ignoring message from group: ${message.from}`);
        //     return;
        // }

        // Only respond if the number is in the allowed list
        const allowedNumbers = [
            '551132803247@s.whatsapp.net',
            '5511947246803@s.whatsapp.net',
            '5511964681711@s.whatsapp.net',
            '5511974407410@s.whatsapp.net',
            '5511991879750@s.whatsapp.net'
        ];
        if (!allowedNumbers.includes(message.from)) {
            this.logger.debug(`Ignoring message from ${message.from}: ${message.body}`);
            return [];
        }

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

        let requestResponse: ResponseStructure[] = [];

        if (!state) {
            this.logger.debug(`No active conversation for user ${from}`);
            requestResponse.push({
                type: "text",
                content: "Desculpe, não entendi sua solicitação. Se você gostaria de pagar uma comanda, por favor, use a frase 'Gostaria de pagar a comanda X'.",
                caption: "",
                to: from,
                reply: true,
            });
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

            case ConversationStep.WaitingForPayment:
                requestResponse = await this.handleWaitingForPayment(from, userMessage, state, message);
                break;

            case ConversationStep.AwaitingUserDecision:
                requestResponse = await this.handleAwaitingUserDecision(from, userMessage, state);
                break;

            case ConversationStep.OverpaymentDecision:
                requestResponse = await this.handleOverpaymentDecision(from, userMessage, state);
                break;

            case ConversationStep.PaymentReminder:
                // requestMessages=await this.handlePaymentReminder(from, userMessage, state);
                break;

            case ConversationStep.CollectPhoneNumber:
                requestResponse = await this.handleCollectPhoneNumber(from, userMessage, state);
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
                    requestResponse.push({
                        type: "text",
                        content: "Desculpe, não entendi sua solicitação. Se você gostaria de pagar uma comanda, por favor, use a frase 'Gostaria de pagar a comanda X'.",
                        caption: "",
                        to: from,
                        reply: true,
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
    ): Promise<ResponseStructure[]> {
        const sentMessages: ResponseStructure[] = [];
        const tableId = this.extractOrderId(userMessage);

        if (!tableId) {
            sentMessages.push(
                ...this.mapTextMessages(
                    [
                        'Desculpe, não entendi o número da comanda. Por favor, diga "Gostaria de pagar a comanda X", onde X é o número da comanda.',
                    ],
                    from,
                    true, // reply deve ser true
                ),
            );
            return sentMessages;
        }

        const tableIdInt = parseInt(tableId, 10);
        const orderProcessingInfo = await this.isOrderBeingProcessed(tableId, from);

        if (!orderProcessingInfo.isProcessing) {
            // Atualiza o contexto da conversa para "ProcessingOrder"
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
                    ['👋 *Coti Pagamentos* - Que ótimo! Estamos processando sua comanda, por favor aguarde. 😁'],
                    from,
                    true, // reply deve ser true
                ),
            );

            // Processa a comanda
            const processingMessages = await this.handleProcessingOrder(from, state, tableIdInt);
            sentMessages.push(...processingMessages);

            return sentMessages;
        }

        // Verifica inatividade do usuário anterior
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
                this.logger.warn(
                    `Unable to mark conversation as errored for user ${userNumber}: Missing conversation ID.`,
                );
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
                    ['👋 *Coti Pagamentos* - Que ótimo! Estamos processando sua comanda, por favor aguarde. 😁'],
                    from,
                    true, // reply deve ser true
                ),
            );

            // Processa a comanda
            const processingMessages = await this.handleProcessingOrder(from, state, tableIdInt);
            sentMessages.push(...processingMessages);

            return sentMessages;
        }

        // Se outra pessoa já está processando, verifica o status da conta
        const step = otherState?.conversationContext?.currentStep;
        const splittingSteps = [
            ConversationStep.SplitBill,
            ConversationStep.SplitBillNumber,
            ConversationStep.WaitingForContacts,
        ];

        if (step && splittingSteps.includes(step)) {
            sentMessages.push(
                ...this.mapTextMessages(
                    [
                        `Sua comanda está em processo de divisão de conta. O número *${userNumber}* está compartilhando os contatos para dividir a conta. Por favor, aguarde ou entre em contato com essa pessoa para participar da divisão.`,
                    ],
                    from,
                    true, // reply deve ser true
                ),
            );
        } else {
            sentMessages.push(
                ...this.mapTextMessages(
                    ['Desculpe, esta comanda já está sendo processada por outra pessoa.'],
                    from,
                    true, // reply deve ser true
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
    ): Promise<ResponseStructure[]> {
        const sentMessages: ResponseStructure[] = [];
        const conversationId = state._id.toString();

        try {
            // Obtém os dados do pedido
            const orderData = await this.retryRequestWithNotification({
                from,
                requestFunction: () => this.tableService.orderMessage(tableId),
                state,
            });

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

    private mapTextMessages(messages: string[], to: string, reply: boolean = false): ResponseStructure[] {
        return messages.map((message) => ({
            type: 'text' as 'text',
            content: message,
            caption: '',
            to,
            reply: reply,
        }));
    }


    private async handleConfirmOrder(
        from: string,
        userMessage: string,
        state: ConversationDto,
    ): Promise<ResponseStructure[]> {
        const sentMessages: ResponseStructure[] = [];
        const positiveResponses = ['1', 'sim', 'correta', 'está correta', 'sim está correta'];
        const negativeResponses = ['2', 'não', 'nao', 'não está correta', 'incorreta', 'não correta'];

        const updatedContext: ConversationContextDTO = { ...state.conversationContext };

        const tableId = parseInt(state.tableId, 10);

        if (positiveResponses.some((response) => userMessage.includes(response))) {

            this.notifyWaiterTableStartedPayment(tableId);

            sentMessages.push(
                ...this.mapTextMessages(
                    [
                        '👍 Você gostaria de dividir a conta?\n\n1- Não\n2- Sim, em partes iguais',
                    ],
                    from,
                ),
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

            this.notifyWaiterWrongOrder(tableId);

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
    ): Promise<ResponseStructure[]> {
        const sentMessages: ResponseStructure[] = [];

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
                        'Ok, gostaria de dividir entre quantas pessoas?\n\nLembrando que apenas suportamos a divisão em partes iguais.',
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
    ): Promise<ResponseStructure[]> {
        const sentMessages: ResponseStructure[] = [];

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
                        '😊 Perfeito! Agora, nos envie o contato das pessoas com quem deseja dividir a conta, ou peça para que elas escaneiem o QR Code da sua mesa. 📲',
                        'Assim que recebermos todos os contatos, daremos continuidade ao atendimento e deixaremos tudo prontinho para vocês! 🎉',
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
    ): Promise<ResponseStructure[]> {
        let sentMessages: ResponseStructure[] = [];

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
    ): Promise<ResponseStructure[]> {
        const sentMessages: ResponseStructure[] = [];
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
        state: ConversationDto,
    ): Promise<ResponseStructure[]> {
        const sentMessages: ResponseStructure[] = [];
        const { data: orderData } = await this.orderService.getOrder(state.orderId);
        const totalAmount = orderData.totalAmount;
        const numPeople = state.conversationContext.splitInfo.numberOfPeople;
        const individualAmount = parseFloat((totalAmount / numPeople).toFixed(2));

        await this.updateConversationAndCreateTransaction(state, individualAmount, totalAmount);
        await this.notifyIncludedContacts(state, totalAmount, individualAmount);
        // this.notifyWaiterTableSplit(state);

        sentMessages.push(
            ...this.mapTextMessages(
                [
                    'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
                ],
                from,
            ),
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
    ): Promise<ResponseStructure[]> {
        const sentMessages: ResponseStructure[] = [];
        const contacts = state.conversationContext.splitInfo.participants;

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
    ): Promise<ResponseStructure[]> {
        this.logger.error('Erro ao processar o(s) vCard(s):', error);

        const errorMessages = [
            '❌ Ocorreu um erro ao processar o contato. Por favor, tente novamente enviando o contato.',
        ];

        return this.mapTextMessages(errorMessages, from);
    }

    private async promptForContact(
        from: string,
        state: ConversationDto
    ): Promise<ResponseStructure[]> {
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
    private async handleExtraTip(
        from: string,
        userMessage: string,
        state: ConversationDto
    ): Promise<ResponseStructure[]> {
        let sentMessages: ResponseStructure[] = [];
        const noTipKeywords = ['não', 'nao', 'n quero', 'não quero', 'nao quero'];
        const tipPercent = parseFloat(userMessage.replace('%', '').replace(',', '.'));

        if (this.isNoTip(userMessage, noTipKeywords) || tipPercent === 0) {
            sentMessages = await this.handleNoTip(from, state);
        } else if (tipPercent > 0) {
            sentMessages = await this.handleTipAmount(from, state, tipPercent);
        } else {
            sentMessages = await this.handleInvalidTip(from, state);
        }

        // Mantém a criação inicial da transação (caso seja necessária para controle)
        await this.createTransaction(state);

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
    ): Promise<ResponseStructure[]> {
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
    ): Promise<ResponseStructure[]> {
        const sentMessages: ResponseStructure[] = [];
        const userAmount = state.conversationContext.userAmount;
        const totalAmountWithTip = userAmount * (1 + tipPercent / 100);
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
        state.conversationContext.userAmount = totalAmountWithTip;

        return sentMessages;
    }

    private async handleInvalidTip(
        from: string,
        state: ConversationDto
    ): Promise<ResponseStructure[]> {
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
    ): Promise<ResponseStructure[]> {
        let sentMessages: ResponseStructure[] = [];
        const conversationId = state._id.toString();

        // Remove todos os caracteres que não são dígitos
        const cpfLimpo = userMessage.replace(/\D/g, '');

        // Verifica se o CPF possui 11 dígitos e é válido matematicamente
        if (cpfLimpo.length !== 11 || !this.isValidCPF(cpfLimpo)) {
            sentMessages = await this.handleInvalidCPF(from, state);
            return sentMessages;
        }

        // Armazena o CPF no contexto e avança para a etapa de pagamento
        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            currentStep: ConversationStep.WaitingForPayment,
            paymentStartTime: Date.now(),
            cpf: cpfLimpo,
        };

        await this.conversationService.updateConversation(conversationId, {
            userId: state.userId,
            conversationContext: updatedContext,
        });

        // Obtém as mensagens para a etapa de pagamento
        const paymentMessages = await this.handlePaymentInstructions(from, state);
        sentMessages.push(...paymentMessages);

        return sentMessages;
    }

    /**
     * Função para lidar com CPF inválido.
     */
    private async handleInvalidCPF(from: string, state: ConversationDto): Promise<ResponseStructure[]> {
        const messages = ['Por favor, informe um CPF válido com 11 dígitos. 🧐'];
        return this.mapTextMessages(messages, from);
    }

    /**
     * Função para lidar com as instruções de pagamento após a coleta do CPF.
     */
    private async handlePaymentInstructions(from: string, state: ConversationDto): Promise<ResponseStructure[]> {
        const finalAmount = state.conversationContext.userAmount.toFixed(2);
        const messages = [
            `O valor final da sua conta é: *${formatToBRL(finalAmount)}*`,
            'Segue abaixo a chave PIX para pagamento 👇',
            '00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
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
        message: RequestMessage,
        base64Media?: string
    ): Promise<any> {
        let mediaData: string | null = null;
        let mediaType: string | null = null;

        if (message.type === 'image' && base64Media) {
            mediaData = base64Media;
            mediaType = this.extractMimeType(base64Media);
        }

        const paymentMessageData: PaymentProcessorDTO = {
            from,
            userMessage,
            state,
            message,
            mediaData,
            mediaType
        };

        await this.paymentQueue.add(paymentMessageData);
    }

    private extractMimeType(base64: string): string | null {
        const match = base64.match(/^data:(.*?);base64,/);
        return match ? match[1] : null;
    }




    public async processPayment(paymentData: PaymentProcessorDTO): Promise<ResponseStructure[]> {
        const { from, userMessage, message, mediaData, mediaType, state } = paymentData;
        let sentMessages: ResponseStructure[] = [];

        if (this.utilsService.userSentProof(userMessage, message)) {
            sentMessages = await this.processPaymentProof(from, message, mediaData, mediaType, state);
        } else {
            sentMessages = await this.remindIfNoProof(from, state);
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
        message: RequestMessage,
        mediaData: string | null,
        mediaType: string | null,
        state: ConversationDto
    ): Promise<ResponseStructure[]> {
        let sentMessages: ResponseStructure[] = [];

        try {
            const analysisResult = await this.utilsService.extractAndAnalyzePaymentProof(
                mediaData,
                state,
            );
            sentMessages = await this.handleProofAnalysisResult(from, state, analysisResult, mediaData, mediaType);
        } catch (error) {
            this.logger.error('Error processing payment proof:', error);
            sentMessages = await this.handlePaymentProofError(from, state);
        }

        return sentMessages;
    }

    private async handlePaymentProofError(from: string, state: ConversationDto): Promise<ResponseStructure[]> {
        const errorMessage = [
            'Desculpe, não conseguimos processar o comprovante de pagamento. Por favor, envie novamente.',
        ];
        return this.mapTextMessages(errorMessage, from);
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
        paymentData: PaymentProofDTO,
        mediaData: string | null,
        mediaType: string | null
    ): Promise<ResponseStructure[]> {
        let sentMessages: ResponseStructure[] = [];

        const isDuplicate = await this.transactionService.isPaymentProofTransactionIdDuplicate(
            state.userId,
            paymentData.id_transacao,
        );

        if (isDuplicate) {
            sentMessages = await this.handleDuplicateProof(from, state);
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
        };

        if (!isBeneficiaryCorrect) {
            sentMessages = await this.handleInvalidBeneficiary(from, state);
            return sentMessages;
        }

        if (isAmountCorrect) {
            sentMessages = await this.handleCorrectPayment(from, state, updateTransactionData);
        } else if (isOverpayment) {
            sentMessages = await this.handleOverpayment(from, state, updateTransactionData, amountPaid);
        } else {
            sentMessages = await this.handleUnderpayment(from, state, updateTransactionData, amountPaid);
        }

        if (mediaData && mediaType) {
            this.sendProofToGroup(mediaData, mediaType, state);
        }

        const updateAmountResponse = await this.orderService.updateAmountPaidAndCheckOrderStatus(
            state.orderId,
            amountPaid,
            state.userId
        );
        const isFullPaymentAmountPaid = updateAmountResponse.data.isPaid;

        if (isFullPaymentAmountPaid) {
            const tableId = parseInt(state.tableId);
            await this.tableService.finishPayment(tableId);
            this.notifyWaiterTablePaymentComplete(state);
        } else {
            this.notifyWaiterPaymentMade(state);
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
        state: ConversationDto
    ): Promise<ResponseStructure[]> {
        const duplicateMessage = [
            '❌ Este comprovante de pagamento já foi recebido anteriormente.\n\n Por favor, verifique seu comprovante.',
        ];

        return this.mapTextMessages(duplicateMessage, from);
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
        state: ConversationDto
    ): Promise<ResponseStructure[]> {
        const timeSincePaymentStart = Date.now() - state.conversationContext.paymentStartTime;

        if (timeSincePaymentStart > 5 * 60 * 1000) {
            const messages = [
                'Notamos que ainda não recebemos seu comprovante. Se precisar de ajuda ou tiver algum problema, estamos aqui para ajudar! 👍',
            ];

            const sentMessages = this.mapTextMessages(messages, from);

            const updatedContext: ConversationContextDTO = {
                ...state.conversationContext,
                currentStep: ConversationStep.PaymentReminder,
            };

            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: updatedContext,
            });

            return sentMessages;
        }

        return [];
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
        state: ConversationDto
    ): Promise<ResponseStructure[]> {
        const errorMessage = [
            '❌ O comprovante enviado apresenta inconsistências.\n👨‍💼 Um de nossos atendentes está a caminho para te ajudar!',
        ];

        const sentMessages = this.mapTextMessages(errorMessage, from);

        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            currentStep: ConversationStep.PaymentInvalid,
        };

        await this.conversationService.updateConversation(
            state._id.toString(),
            { userId: state.userId, conversationContext: updatedContext },
        );

        return sentMessages;
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
        updateTransactionData: TransactionDTO
    ): Promise<ResponseStructure[]> {
        const messages = [
            '*👋  Coti Pagamentos* - Pagamento Confirmado ✅\n\nEsperamos que sua experiência tenha sido excelente.',
            'Por favor, informe o seu número de telefone com DDD para enviarmos o comprovante de pagamento.\n\n💡 Exemplo: (11) 91234-5678',
        ];

        const sentMessages = this.mapTextMessages(messages, from);

        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            currentStep: ConversationStep.CollectPhoneNumber,
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

        return sentMessages;
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
        updateTransactionData: TransactionDTO,
        amountPaid: number
    ): Promise<ResponseStructure[]> {
        const excessAmount = amountPaid - state.conversationContext.userAmount;
        const messages = [
            `❌ Você pagou um valor superior ao necessário: *${formatToBRL(amountPaid)}* ao invés de *${formatToBRL(state.conversationContext.userAmount)}*.`,
            `Você deseja:\n\n1- Adicionar o valor excedente de *${formatToBRL(excessAmount)}* como gorjeta.\n2- Solicitar o estorno do valor extra.`,
        ];

        const sentMessages = this.mapTextMessages(messages, from);

        const updatedContext: ConversationContextDTO = {
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

        return sentMessages;
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
        updateTransactionData: TransactionDTO,
        amountPaid: number
    ): Promise<ResponseStructure[]> {
        const remainingAmount = state.conversationContext.userAmount - amountPaid;
        const errorMessage = [
            `❌ O valor pago foi de ${formatToBRL(amountPaid)} enquanto deveria ser ${formatToBRL(state.conversationContext.userAmount)}.`,
            `💰 Você ainda tem um saldo de ${formatToBRL(remainingAmount)} a pagar.\n\nEscolha uma das opções abaixo:\n1- Pagar valor restante.\n2- Chamar um atendente.`,
        ];

        const sentMessages = this.mapTextMessages(errorMessage, from);

        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            currentStep: ConversationStep.AwaitingUserDecision,
            underPaymentAmount: remainingAmount,
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

        return sentMessages;
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
        state: ConversationDto
    ): Promise<ResponseStructure[]> {
        let sentMessages: ResponseStructure[] = [];
        const { data: transactionData } = await this.transactionService.getLastOverpaidTransactionByUserAndOrder(
            state.userId,
            state.orderId
        );

        const excessAmount = transactionData.amountPaid - transactionData.expectedAmount;
        const transactionId = transactionData._id.toString();

        const addAsTipResponses = ['1', 'adicionar como gorjeta', 'gorjeta', 'adicionar gorjeta'];
        const refundResponses = ['2', 'estorno', 'solicitar estorno', 'extornar'];

        if (addAsTipResponses.some((response) => userMessage.includes(response))) {
            const messages = [
                `🎉 Muito obrigado pela sua generosidade! O valor de *${formatToBRL(excessAmount)}* foi adicionado como gorjeta. 😊`,
                'Por favor, informe o seu número de telefone com DDD para enviarmos o comprovante de pagamento.\n\n💡 Exemplo: (11) 91234-5678',
            ];
            sentMessages = this.mapTextMessages(messages, from);

            const alreadyPaidTip = state.conversationContext.tipAmount || 0;

            const updatedContext: ConversationContextDTO = {
                ...state.conversationContext,
                currentStep: ConversationStep.CollectPhoneNumber,
                tipAmount: alreadyPaidTip + excessAmount,
            };

            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: updatedContext,
            });

            await this.transactionService.changeTransactionStatusToConfirmed(transactionId);
        } else if (refundResponses.some((response) => userMessage.includes(response))) {
            const messages = [
                `Entendido! Vamos providenciar o estorno do valor excedente de *${formatToBRL(excessAmount)}* o mais rápido possível. 💸`,
                'Por favor, informe o seu número de telefone com DDD para enviarmos o comprovante de pagamento.\n\n💡 Exemplo: (11) 91234-5678',
            ];
            sentMessages = this.mapTextMessages(messages, from);

            const updatedContext: ConversationContextDTO = {
                ...state.conversationContext,
                currentStep: ConversationStep.CollectPhoneNumber,
            };

            this.notifyRefundRequest(parseInt(state.tableId), excessAmount);

            await this.conversationService.updateConversation(state._id.toString(), {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        } else {
            const messages = [
                'Desculpe, não entendi sua resposta.',
                `Por favor, escolha uma das opções abaixo:\n1- Adicionar o valor excedente como gorjeta.\n2- Solicitar o estorno do valor extra.`,
            ];
            sentMessages = this.mapTextMessages(messages, from);
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
        state: ConversationDto
    ): Promise<ResponseStructure[]> {
        let sentMessages: ResponseStructure[] = [];
        const conversationId = state._id.toString();

        const positiveResponses = ['1', 'nova transação', 'realizar nova transação', 'pagar valor restante'];
        const assistanceResponses = ['2', 'chamar atendente', 'ajuda', 'preciso de ajuda'];

        if (positiveResponses.some((response) => userMessage.includes(response))) {
            const { data: transactionData } = await this.transactionService.getLastUnderpaidTransactionByUserAndOrder(
                state.userId,
                state.orderId
            );

            const remainingAmount = state.conversationContext.userAmount - transactionData.amountPaid;
            const transactionId = transactionData._id.toString();
            state.conversationContext.userAmount = remainingAmount;

            sentMessages = this.mapTextMessages(
                [
                    `Valor a ser pago: *${formatToBRL(remainingAmount)}*`,
                    'Segue abaixo a chave PIX para pagamento 👇',
                    '00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
                    'Por favor, envie o comprovante! 📄✅',
                ],
                from
            );

            const updatedContext: ConversationContextDTO = {
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
            };

            await this.transactionService.createTransaction(newTransactionData);
        } else if (assistanceResponses.some((response) => userMessage.includes(response))) {
            sentMessages = this.mapTextMessages(
                ['👨‍💼 Um de nossos atendentes já está a caminho para te ajudar!'],
                from
            );

            const updatedContext: ConversationContextDTO = {
                ...state.conversationContext,
                currentStep: ConversationStep.PaymentAssistance,
            };

            await this.conversationService.updateConversation(conversationId, {
                userId: state.userId,
                conversationContext: updatedContext,
            });
        } else {
            sentMessages = this.mapTextMessages(
                [
                    'Desculpe, não entendi sua resposta.',
                    'Por favor, escolha uma das opções abaixo:\n' +
                    '1- Pagar valor restante.\n' +
                    '2- Chamar um atendente.',
                ],
                from
            );
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

    private async handleCollectPhoneNumber(
        from: string,
        userMessage: string,
        state: ConversationDto
    ): Promise<ResponseStructure[]> {
        let sentMessages: ResponseStructure[] = [];
        const conversationId = state._id.toString();

        const phoneClean = userMessage.replace(/\D/g, '');

        if (phoneClean.length < 10) {
            sentMessages = this.mapTextMessages(
                ['Por favor, informe um número de telefone com DDD (mínimo 10 dígitos). 🧐'],
                from
            );
            return sentMessages;
        }

        const updatedContext: ConversationContextDTO = {
            ...state.conversationContext,
            phone: phoneClean,
            currentStep: ConversationStep.Feedback,
        };

        await this.conversationService.updateConversation(conversationId, {
            userId: state.userId,
            conversationContext: updatedContext,
        });

        sentMessages = this.mapTextMessages(
            [
                '👋  Coti Pagamentos - Pagamento Finalizado ✅\n\nEsperamos que sua experiência tenha sido excelente.',
                'Como você se sentiria se não pudesse mais usar o nosso serviço?\n\nEscolha uma das opções abaixo',
                'a) Muito decepcionado\nb) Um pouco decepcionado\nc) Não faria diferença'
            ],
            from
        );

        return sentMessages;
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
    ): Promise<ResponseStructure[]> {
        let sentMessages: ResponseStructure[] = [];
        const conversationId = state._id.toString();

        if (!state.conversationContext.feedback) {
            state.conversationContext.feedback = new FeedbackDTO();
        }

        const feedback = state.conversationContext.feedback;
        let updatedContext: ConversationContextDTO = { ...state.conversationContext };

        if (typeof feedback.mustHaveScore === 'undefined') {
            const userResponse = userMessage.trim().toLowerCase();
            const validOptions: Record<string, string> = {
                'a': 'Muito decepcionado',
                'b': 'Um pouco decepcionado',
                'c': 'Não faria diferença',
            };

            if (!Object.keys(validOptions).includes(userResponse)) {
                sentMessages = this.mapTextMessages(
                    [
                        'Por favor, escolha uma das opções abaixo e envie apenas a letra correspondente:',
                        'a) Muito decepcionado\nb) Um pouco decepcionado\nc) Não faria diferença',
                    ],
                    from
                );
            } else {
                feedback.mustHaveScore = validOptions[userResponse];

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
    ): Promise<ResponseStructure[]> {
        let sentMessages: ResponseStructure[] = [];
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


    private async notifyWaiterTableSplit(state: ConversationDto): Promise<ResponseStructure[]> {
        const groupId = '120363379149730361@g.us'; // [HOM][Atendentes] Cris Parrilla
        const message = `👋 Coti Pagamentos - Mesa ${state.tableId} irá compartilhar o pagamento`;

        return this.mapTextMessages([message], groupId);
    }

    private async notifyWaiterTablePaymentComplete(state: ConversationDto): Promise<ResponseStructure[]> {
        const groupId = '120363379149730361@g.us'; // [HOM][Atendentes] Cris Parrilla

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

    private async notifyWaiterPaymentMade(state: ConversationDto): Promise<ResponseStructure[]> {
        const groupId = '120363379149730361@g.us'; // [HOM][Atendentes] Cris Parrilla

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

                if (name.includes('@c.us')) {
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

    private async notifyWaiterAuthenticationStatus(message: string, state: ConversationDto): Promise<ResponseStructure[]> {
        const groupId = '120363379149730361@g.us'; // [HOM][Atendentes] Cris Parrilla

        this.logger.log(`[notifyWaiterAuthenticationStatus] Notificação de status de autenticação: ${message}`);

        try {
            return this.mapTextMessages([message], groupId);
        } catch (error) {
            this.logger.error(`[notifyWaiterAuthenticationStatus] Erro ao enviar mensagem para o grupo ${groupId}: ${error}`);
            return [];
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

    private async sendProofToGroup(mediaData: string, mediaType: string, state: ConversationDto): Promise<ResponseStructure[]> {
        const groupId = '120363379784971558@g.us'; // [HOM][Comprovantes] Cris Parrilla

        this.logger.log(`[sendProofToGroup] Enviando comprovante para o grupo: ${groupId}`);

        try {
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
                }
            ];
        } catch (error) {
            this.logger.error(`[sendProofToGroup] Erro ao enviar mensagem para o grupo ${groupId}: ${error}`);
            return [];
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

    private async notifyWaiterTableStartedPayment(tableNumber: number): Promise<ResponseStructure[]> {
        const groupId = '120363379149730361@g.us'; // [HOM][Atendentes] Cris Parrilla

        this.logger.log(`[notifyWaiterTableStartedPayment] Notificação de início de pagamentos para a mesa ${tableNumber}`);

        try {
            const message = `👋 *Coti Pagamentos* - A mesa ${tableNumber} iniciou o processo de pagamentos.`;
            return this.mapTextMessages([message], groupId);
        } catch (error) {
            this.logger.error(`[notifyWaiterTableStartedPayment] Erro ao enviar notificação de início de pagamentos para o grupo ${groupId}: ${error}`);
            return [];
        }
    }

    private async notifyRefundRequest(tableNumber: number, refundAmount: number): Promise<ResponseStructure[]> {
        const groupId = '120363360992675621@g.us'; // [HOM][Reembolso] Cris Parrilla

        this.logger.log(`[notifyRefundRequestToWaiter] Notificação de estorno para a mesa ${tableNumber}`);

        try {
            const message = `👋 *Coti Pagamentos* - A mesa ${tableNumber} solicitou um estorno de *${formatToBRL(refundAmount)}*.`;
            return this.mapTextMessages([message], groupId);
        } catch (error) {
            this.logger.error(`[notifyRefundRequestToWaiter] Erro ao enviar notificação de estorno para o grupo ${groupId}: ${error}`);
            return [];
        }
    }

    private async notifyWaiterWrongOrder(tableNumber: number): Promise<ResponseStructure[]> {
        const groupId = '120363379149730361@g.us'; // [HOM][Atendentes] Cris Parrilla

        this.logger.log(`[notifyWaiterWrongOrder] Notificação de pedido errado para a mesa ${tableNumber}`);

        try {
            const message = `👋 *Coti Pagamentos* - A Mesa ${tableNumber} relatou um problema com os pedidos da comanda.\n\nPor favor, dirija-se à mesa para verificar.`;
            return this.mapTextMessages([message], groupId);
        } catch (error) {
            this.logger.error(`[notifyWaiterWrongOrder] Erro ao enviar notificação de pedido errado para o grupo ${groupId}: ${error}`);
            return [];
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
                    // await this.sendMessageWithDelay({ from, messages: [delayMessage], state });
                }

                if (attempts < maxRetries) {
                    await new Promise((resolve) => setTimeout(resolve, delayBetweenRetries));
                }

                this.notifyWaiterAuthenticationStatus(groupMessage, state);
            }
        }

        const errorMessage = this.generateStageErrorMessage(state);
        // await this.sendMessageWithDelay({ from, messages: [errorMessage], state });

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


    // private async sendMessageWithDelay(params: SendMessageParams): Promise<string[]> {

    //     const {
    //         from,
    //         messages,
    //         state,
    //         delay = 2000,
    //         toAttendants = false,
    //         media,
    //         caption,
    //     } = params;

    //     const sentMessages: string[] = [];
    //     const messageLogs: MessageDTO[] = [];



    //     for (const msg of messages) {
    //         const formattedMessage = toAttendants
    //             ? `${this.getCurrentTime()}\n${msg}`
    //             : msg;

    //         if (!this.debugMode) {
    //             await this.client.sendMessage(from, formattedMessage);
    //         } else {
    //             this.logger.debug(`DEBUG mode ON: Simulando envio de mensagem para ${from}: ${formattedMessage}`);
    //         }

    //         sentMessages.push(msg);

    //         messageLogs.push({
    //             messageId: `msg-${Date.now()}`, // Considerar uma geração de IDs mais robusta
    //             content: formattedMessage,
    //             type: MessageType.Bot,
    //             timestamp: new Date(),
    //             senderId: from,
    //         });

    //         await this.delay(delay);
    //     }

    //     if (media) {
    //         try {

    //             await this.client.sendMessage(from, media, { caption });

    //             messageLogs.push({
    //                 messageId: `media-${Date.now()}`,
    //                 content: caption,
    //                 type: MessageType.Bot,
    //                 timestamp: new Date(),
    //                 senderId: from,
    //             });

    //             this.logger.log(`Mídia enviada para: ${from}`);
    //         } catch (error) {
    //             this.logger.error(`Erro ao enviar mídia para ${from}: ${error}`);
    //         }
    //     }

    //     // Salvar logs no banco, se necessário
    //     // if (messageLogs.length > 0) {
    //     //     await this.conversationService.addMessages(state._id.toString(), messageLogs);
    //     // }

    //     return sentMessages;
    // }

    // Função auxiliar para implementar delay
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
        return parseFloat((totalAmount / numPeople).toFixed(2));
    }

}

