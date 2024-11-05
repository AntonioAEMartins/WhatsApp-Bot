// src/whatsapp/whatsapp.service.ts

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import { TableService } from 'src/table/table.service';
import { LangchainService } from 'src/langchain/langchain.service';
import { UserConversationDTO, ConversationStep, PaymentStatus, ConversationContextDTO, PaymentDetailsDTO, SplitInfoDTO, FeedbackDTO } from './dto/conversation.dto';
import { formatToBRL } from './utils/currency.utils';

@Injectable()
export class WhatsAppService implements OnModuleInit {
    private client: Client;
    private readonly logger = new Logger(WhatsAppService.name);

    // Maps to store conversation state per client
    private clientStates: Map<string, UserConversationDTO> = new Map();
    private debugMode = process.env.DEBUG === 'true';

    constructor(
        private readonly tableService: TableService,
        private readonly langchainService: LangchainService,
    ) {
        // Initialize the WhatsApp client with LocalAuth for persistent sessions
        this.client = new Client({
            puppeteer:{
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-gpu'
                ],
            },
            authStrategy: new LocalAuth({
                clientId: 'coti-payments', // You can customize this ID to uniquely identify the session
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
            // const allowedNumbers = [
            //     '551132803247@c.us',
            //     '5511993109344@c.us',
            //     '5518997923440@c.us',
            //     '5511964681711@c.us'
            // ];
            // if (!allowedNumbers.includes(message.from)) {
            //     this.logger.debug(`Ignoring message from ${message.from}: ${message.body}`);
            //     return;
            // }

            // Calculate message age to avoid processing old messages
            const currentTime = Math.floor(Date.now() / 1000); // Get current time in seconds
            const messageAge = currentTime - message.timestamp; // Message timestamp is in seconds
            const maxAllowedAge = 30; // 10 seconds

            if (messageAge > maxAllowedAge) {
                this.logger.debug(`Ignoring old message from ${message.from}: ${message.body}`);
                return; // Ignore message if it's older than 10 seconds
            }

            const contact = await message.getContact();
            const from = contact.id._serialized;
            let state = this.clientStates.get(from);

            if (!state) {
                // Initialize a new state
                state = new UserConversationDTO();
                state.id = from;
                state.conversationContext = new ConversationContextDTO();
                state.conversationContext.currentStep = ConversationStep.Initial;
                this.clientStates.set(from, state);
            }

            const userMessage = message.body.trim().toLowerCase();

            // Log current state for debugging
            this.logger.debug(
                `User: ${from}, State: ${state.conversationContext.currentStep}, Message: "${userMessage}"`,
            );

            switch (state.conversationContext.currentStep) {
                case ConversationStep.ProcessingOrder:
                    // Currently processing order; no user input expected
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
                        const order_id = this.extractOrderId(userMessage);

                        if (!order_id) {
                            await message.reply(
                                'Desculpe, não entendi o número da comanda. Por favor, diga "Gostaria de pagar a comanda X", onde X é o número da comanda.',
                            );
                            return;
                        }

                        const orderProcessingInfo = this.isOrderBeingProcessed(order_id, from);

                        if (orderProcessingInfo.isProcessing) {
                            const otherState = orderProcessingInfo.state;
                            const userNumber = orderProcessingInfo.userNumber;

                            if (
                                [
                                    ConversationStep.SplitBill,
                                    ConversationStep.SplitBillNumber,
                                    ConversationStep.WaitingForContacts,
                                ].includes(otherState.conversationContext.currentStep)
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

                        state.conversationContext.currentStep = ConversationStep.ProcessingOrder;
                        if (!state.conversationContext.paymentDetails) {
                            state.conversationContext.paymentDetails = new PaymentDetailsDTO();
                        }
                        state.conversationContext.paymentDetails.orderId = parseInt(order_id);
                        this.clientStates.set(from, state);

                        await message.reply(
                            '👋 *Coti Pagamentos* - Que ótimo! Estamos processando sua comanda, por favor aguarde. 😁',
                        );
                        await this.handleProcessingOrder(from, state, parseInt(order_id));
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

    private extractOrderId(message: string): string | null {
        const match = message.match(/\bcomanda\s*(\d+)/i);
        return match ? match[1] : null;
    }

    private calculateUserAmount(state: UserConversationDTO): number {
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
        delay: number = 2000,
    ): Promise<string[]> {
        const sentMessages = [];
        for (const msg of messages) {
            if (!this.debugMode) {
                await this.client.sendMessage(from, msg);
            } else {
                this.logger.debug(`DEBUG mode ON: Simulating sending message to ${from}: ${msg}`);
            }
            sentMessages.push(msg); // Track the message being "sent"
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
        return sentMessages; // Return the list of messages "sent"
    }

    // Helper function to check if an order is already being processed
    private isOrderBeingProcessed(
        order_id: string,
        from: string,
    ): { isProcessing: boolean; state?: UserConversationDTO; userNumber?: string } {
        for (const [otherFrom, otherState] of this.clientStates.entries()) {
            if (
                otherState.conversationContext.paymentDetails &&
                otherState.conversationContext.paymentDetails.orderId === parseInt(order_id) &&
                otherFrom !== from &&
                ![ConversationStep.Completed, ConversationStep.IncompleteOrder].includes(
                    otherState.conversationContext.currentStep,
                )
            ) {
                const userNumber = otherFrom.split('@')[0]; // Extract the phone number
                return { isProcessing: true, state: otherState, userNumber };
            }
        }
        return { isProcessing: false };
    }

    // 1. Processing Order
    private async handleProcessingOrder(
        from: string,
        state: UserConversationDTO,
        order_id: number,
    ): Promise<string[]> {
        try {
            const orderData = await this.tableService.orderMessage(order_id);
            console.log('orderData', orderData);
            const orderMessage = orderData.message;
            const orderDetails = orderData.details;

            const messages = [orderMessage, '👍 A sua comanda está correta?\n\n1- Sim\n2- Não'];
            const sentMessages = await this.sendMessageWithDelay(from, messages);
            state.conversationContext.currentStep = ConversationStep.ConfirmOrder;
            state.orderDetails = {
                tableId: order_id,
                items: orderDetails.orders,
                totalAmount: orderDetails.total,
                appliedDiscount: orderDetails.discount,
            };
            this.clientStates.set(from, state);
            return sentMessages; // Return the sent messages
        } catch (error) {
            const messages = [
                'Desculpe, não foi possível encontrar a comanda. Por favor, verifique o número e tente novamente.',
            ];
            const sentMessages = await this.sendMessageWithDelay(from, messages);
            state.conversationContext.currentStep = ConversationStep.OrderNotFound;
            this.clientStates.set(from, state);
            return sentMessages;
        }
    }

    // 2. Confirm Order
    private async handleConfirmOrder(
        from: string,
        userMessage: string,
        state: UserConversationDTO,
    ): Promise<string[]> {
        const sentMessages = [];
        const positiveResponses = ['1', 'sim', 'correta', 'está correta', 'sim está correta'];
        const negativeResponses = ['2', 'não', 'nao', 'não está correta', 'incorreta', 'não correta'];

        if (positiveResponses.some((response) => userMessage.includes(response))) {
            const messages = [
                '👍 Você gostaria de dividir a conta?\n\n1- Sim, em partes iguais\n2- Não',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.conversationContext.currentStep = ConversationStep.SplitBill;
        } else if (negativeResponses.some((response) => userMessage.includes(response))) {
            const messages = [
                'Que pena! Lamentamos pelo ocorrido e o atendente responsável irá conversar com você.',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.conversationContext.currentStep = ConversationStep.IncompleteOrder
        } else {
            const messages = ['Por favor, responda com 1 para Sim ou 2 para Não.'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
        }
        this.clientStates.set(from, state);
        return sentMessages;
    }

    // 3. Split Bill
    private async handleSplitBill(
        from: string,
        userMessage: string,
        state: UserConversationDTO,
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
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.conversationContext.currentStep = ConversationStep.SplitBillNumber;
        } else if (negativeResponses.some((response) => userMessage.includes(response))) {
            const messages = [
                'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.conversationContext.currentStep = ConversationStep.ExtraTip;

            // Define o valor para o usuário, pois ele escolheu não dividir a conta
            state.conversationContext.userAmount = this.calculateUserAmount(state);
        } else {
            const messages = ['Por favor, responda com 1 para Sim ou 2 para Não.'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
        }
        this.clientStates.set(from, state);
        return sentMessages;
    }

    // 4. Split Bill Number
    private async handleSplitBillNumber(
        from: string,
        userMessage: string,
        state: UserConversationDTO,
    ): Promise<string[]> {
        const sentMessages = [];

        // Extract the first number found in the message
        const numPeopleMatch = userMessage.match(/\d+/);
        const numPeople = numPeopleMatch ? parseInt(numPeopleMatch[0]) : NaN;

        if (!isNaN(numPeople) && numPeople > 1) {
            if (!state.conversationContext.splitInfo) {
                state.conversationContext.splitInfo = new SplitInfoDTO();
            }
            state.conversationContext.splitInfo.numberOfPeople = numPeople;
            state.conversationContext.splitInfo.contacts = [];
            const messages = [
                '😊 Perfeito! Agora, nos envie o contato das pessoas com quem deseja dividir a conta, ou peça para que elas escaneiem o QR Code da sua mesa. 📲',
                'Assim que recebermos todos os contatos, daremos continuidade ao atendimento e deixaremos tudo prontinho para vocês! 🎉'
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.conversationContext.currentStep = ConversationStep.WaitingForContacts;
        } else {
            const messages = ['Por favor, informe um número válido de pessoas (maior que 1).'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
        }

        this.clientStates.set(from, state);
        return sentMessages; // Return the sent messages
    }

    // 5. Waiting for Contacts
    private async handleWaitingForContacts(
        from: string,
        state: UserConversationDTO,
        message: Message,
    ): Promise<string[]> {
        const sentMessages = [];

        if (message.type === 'vcard' || message.type === 'multi_vcard') {
            try {
                const vcardDataArray = message.vCards;
                let responseMessage = `✨ *Contato(s) Recebido(s) com Sucesso!* ✨\n`;

                for (const vcardData of vcardDataArray) {
                    console.log('vcardData', vcardData);

                    const vcardName = vcardData.split('FN:')[1].split('\n')[0];
                    let vcardPhone = vcardData.split('waid=')[1].split(':')[1].split('\n')[0];
                    vcardPhone = vcardPhone.replace(/\D/g, ''); // Remove all non-numeric characters

                    if (!state.conversationContext.splitInfo.receivedContacts) {
                        state.conversationContext.splitInfo.receivedContacts = 0;
                    }

                    state.conversationContext.splitInfo.receivedContacts += 1;

                    // Store the received contact
                    state.conversationContext.splitInfo.contacts.push({
                        name: vcardName,
                        phone: vcardPhone,
                        individualAmount: 0, // Será calculado posteriormente
                    });

                    // Append each contact’s details to the response message
                    responseMessage += `\n👤 *Nome:* ${vcardName}\n📞 *Número:* ${vcardPhone}\n`;
                }

                // Calculate remaining contacts after processing all received contacts
                const remainingContacts =
                    state.conversationContext.splitInfo.numberOfPeople -
                    1 -
                    state.conversationContext.splitInfo.receivedContacts;

                // If more contacts are still needed, inform the user
                if (remainingContacts > 0) {
                    responseMessage += `\n🕒 Aguardando mais *${remainingContacts}* contato(s) para continuar.`;
                }

                sentMessages.push(...(await this.sendMessageWithDelay(from, [responseMessage])));

                // If all required contacts have been received, proceed to the next step
                if (remainingContacts <= 0) {
                    const completionMessage =
                        '🎉 Todos os contatos foram recebidos! Vamos prosseguir com seu atendimento. 😄';
                    sentMessages.push(...(await this.sendMessageWithDelay(from, [completionMessage])));
                    state.conversationContext.currentStep = ConversationStep.ExtraTip; // Next step for the main client

                    // Calculate each client's share
                    const totalAmount = state.orderDetails.totalAmount;
                    const numPeople = state.conversationContext.splitInfo.numberOfPeople;
                    const individualAmount = parseFloat((totalAmount / numPeople).toFixed(2));

                    // Set individual amount for the main client
                    state.conversationContext.paymentDetails = new PaymentDetailsDTO();
                    state.conversationContext.paymentDetails.totalDue = individualAmount;
                    state.conversationContext.paymentDetails.orderId =
                        state.conversationContext.paymentDetails.orderId;
                    state.conversationContext.paymentDetails.status = PaymentStatus.Pending;
                    state.conversationContext.paymentDetails.initiatedAt = Date.now();

                    state.conversationContext.userAmount = individualAmount;

                    // Set individual amounts for contacts
                    state.conversationContext.splitInfo.contacts = state.conversationContext.splitInfo.contacts.map(
                        (contact) => ({
                            ...contact,
                            individualAmount,
                        }),
                    );

                    // Initiate interaction with secondary clients
                    for (const contact of state.conversationContext.splitInfo.contacts) {
                        console.log('HandleWaitingForContacts - Contact', contact);
                        const contactId = `${contact.phone}@c.us`;
                        const contactState = new UserConversationDTO();
                        contactState.id = contactId;
                        contactState.conversationContext = new ConversationContextDTO();
                        contactState.conversationContext.currentStep = ConversationStep.ExtraTip;

                        contactState.conversationContext.splitInfo = new SplitInfoDTO();
                        contactState.conversationContext.splitInfo.numberOfPeople = numPeople;

                        contactState.orderDetails = state.orderDetails;

                        contactState.conversationContext.paymentDetails = new PaymentDetailsDTO();
                        contactState.conversationContext.paymentDetails.orderId =
                            state.conversationContext.paymentDetails.orderId;
                        contactState.conversationContext.paymentDetails.totalDue = individualAmount;
                        contactState.conversationContext.paymentDetails.status = PaymentStatus.Pending;
                        contactState.conversationContext.paymentDetails.initiatedAt = Date.now();

                        contactState.conversationContext.userAmount = individualAmount;

                        this.clientStates.set(contactId, contactState);

                        // Send initial message to secondary client
                        const messages = [
                            `👋 Coti Pagamentos - Olá! Você foi incluído na divisão do pagamento da comanda *${contactState.conversationContext.paymentDetails.orderId}* no restaurante Cris Parrilla. Aguarde para receber mais informações sobre o pagamento.`,
                            `Sua parte na conta é de *${formatToBRL(individualAmount)}*.`,
                            'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
                        ];
                        await this.sendMessageWithDelay(contactId, messages);
                    }

                    // Continue the flow for the main client
                    const messages = [
                        'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
                    ];
                    sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
                }
            } catch (error) {
                this.logger.error('Erro ao processar o(s) vCard(s):', error);
                const errorMessages = [
                    '❌ Ocorreu um erro ao processar o contato. Por favor, tente novamente enviando o contato.',
                ];
                sentMessages.push(...(await this.sendMessageWithDelay(from, errorMessages)));
            }
        } else {
            console.log('Message Type', message.type);
            const promptMessages = [
                '📲 Por favor, envie o contato da pessoa com quem deseja dividir a conta.',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, promptMessages)));
        }

        this.clientStates.set(from, state);
        return sentMessages;
    }

    // 6. Extra Tip
    private async handleExtraTip(
        from: string,
        userMessage: string,
        state: UserConversationDTO,
    ): Promise<string[]> {
        const sentMessages = [];
        const noTipKeywords = ['não', 'nao', 'n quero', 'não quero', 'nao quero'];
        const tipPercent = parseFloat(userMessage.replace('%', '').replace(',', '.'));

        // Corrected line: Use state.conversationContext.userAmount if defined, otherwise use total order amount
        const userAmount = state.conversationContext.userAmount;


        if (noTipKeywords.some((keyword) => userMessage.includes(keyword)) || tipPercent === 0) {
            const messages = [
                'Sem problemas!',
                `O valor final da sua conta é: *${formatToBRL(userAmount.toFixed(2))}*`,
                'Segue abaixo a chave PIX para pagamento 👇',
                '00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
                'Por favor, envie o comprovante! 📄✅',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.conversationContext.currentStep = ConversationStep.WaitingForPayment;
            state.conversationContext.paymentStartTime = Date.now();
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

            console.log("User Amount", userAmount);
            console.log("Number of People", state.conversationContext.splitInfo.numberOfPeople);
            console.log("Tip Percent", tipPercent);
            console.log("Total Amount with Tip", (userAmount * (1 + tipPercent / 100)).toFixed(2));

            const totalAmountWithTip = parseFloat(
                (this.calculateUserAmount(state) * (1 + tipPercent / 100)).toFixed(2),
            );

            const paymentMessages = [
                `O valor final da sua conta é: *${formatToBRL(totalAmountWithTip.toFixed(2))}*`,
                'Segue abaixo a chave PIX para pagamento 👇',
                '00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
                'Por favor, envie o comprovante! 📄✅',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, paymentMessages)));
            state.conversationContext.currentStep = ConversationStep.WaitingForPayment;
            state.conversationContext.paymentStartTime = Date.now();
            state.conversationContext.userAmount = totalAmountWithTip;
        } else {
            const messages = [
                'Por favor, escolha uma das opções de gorjeta: 3%, 5% ou 7%, ou diga que não deseja dar gorjeta.',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
        }

        this.clientStates.set(from, state);
        return sentMessages;
    }

    private async handleWaitingForPayment(
        from: string,
        userMessage: string,
        state: UserConversationDTO,
        message: Message,
    ): Promise<string[]> {
        const sentMessages = [];
        const currentTime = new Date();

        if (userMessage.includes('comprovante') || message.hasMedia) {
            try {
                if (message.hasMedia) {
                    const media = await message.downloadMedia();

                    if (media && media.data) {
                        // Processar o comprovante com OCR
                        const extractedText = await this.langchainService.extractTextFromPDF(media.data);
                        const analysisResult = await this.langchainService.analyzeDocument(
                            extractedText,
                            state.conversationContext.userAmount,
                        );

                        console.log('Analysis Result:', analysisResult);

                        // Validar data de pagamento
                        const paymentDate = new Date(analysisResult.data_pagamento.replace(' - ', 'T'));
                        const timeDifference = (currentTime.getTime() - paymentDate.getTime()) / (1000 * 60); // Diferença em minutos
                        const isRecentPayment = true; // Temporariamente desabilitado para teste

                        // Validar beneficiário e CNPJ
                        const expectedBeneficiary = 'EMPORIO CRISTOVAO';
                        const expectedCNPJ = '42.081.641/0001-68';
                        const isBeneficiaryCorrect =
                            analysisResult.nome_beneficiario?.toUpperCase().includes(expectedBeneficiary) ||
                            analysisResult.cpf_cnpj_beneficiario === expectedCNPJ;

                        // Validar valor pago pelo usuário
                        const paymentValue = parseFloat(analysisResult.valor?.toString() || '0');
                        const isAmountCorrect = paymentValue === state.conversationContext.userAmount;
                        const isOverpayment = paymentValue > state.conversationContext.userAmount;

                        // Condições para validação do pagamento
                        if (isRecentPayment && isBeneficiaryCorrect) {
                            if (isAmountCorrect) {
                                // Pagamento correto
                                const messages = [
                                    'Pagamento confirmado.',
                                    'Muito obrigado por utilizar a *Coti* e realizar pagamentos mais *rápidos* 🙏',
                                    'Esperamos que sua experiência tenha sido excelente. Sua satisfação é muito importante para nós e estamos sempre prontos para te atender novamente! 😊',
                                    'Sua opinião é essencial para nós! Queremos saber:\n\nEm uma escala de 0 a 10, o quanto você recomendaria a Coti para amigos ou colegas?\n(0 = nada provável e 10 = muito provável)',
                                ];
                                sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
                                state.conversationContext.currentStep = ConversationStep.Feedback;
                            } else if (isOverpayment) {
                                // Usuário pagou a mais
                                const excessAmount = paymentValue - state.conversationContext.userAmount;
                                const messages = [
                                    `❌ Você pagou um valor superior ao necessário: *${formatToBRL(paymentValue)}* ao invés de *${formatToBRL(state.conversationContext.userAmount)}*.`,
                                    `Você deseja:\n\n1- Adicionar o valor excedente de *${formatToBRL(excessAmount)}* como gorjeta.\n2- Solicitar o estorno do valor extra.`,
                                ];
                                sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
                                state.conversationContext.currentStep = ConversationStep.OverpaymentDecision;
                                state.conversationContext.excessPaymentAmount = excessAmount;
                            } else {
                                // Valor insuficiente
                                const remainingAmount = state.conversationContext.userAmount - paymentValue;
                                const errorMessage = [
                                    `❌ O valor pago foi de ${formatToBRL(paymentValue)} enquanto deveria ser ${formatToBRL(state.conversationContext.userAmount)}.`,
                                    `💰 Você ainda tem um saldo de ${formatToBRL(remainingAmount)} a pagar.\n\nEscolha uma das opções abaixo:\n1- Pagar valor restante.\n2- Chamar um atendente.`,
                                ];
                                sentMessages.push(...(await this.sendMessageWithDelay(from, errorMessage)));
                                state.conversationContext.userAmount = remainingAmount;
                                state.conversationContext.currentStep = ConversationStep.AwaitingUserDecision;
                            }
                        } else {
                            const errorMessage = [
                                '❌ O comprovante enviado apresenta inconsistências.\n👨‍💼 Um de nossos atendentes está a caminho para te ajudar!',
                            ];
                            sentMessages.push(...(await this.sendMessageWithDelay(from, errorMessage)));
                            state.conversationContext.currentStep = ConversationStep.PaymentInvalid;
                        }
                    }
                }
            } catch (error) {
                this.logger.error('Error processing payment proof:', error);
                const errorMessage = [
                    'Desculpe, não conseguimos processar o comprovante de pagamento. Por favor, envie novamente.',
                ];
                sentMessages.push(...(await this.sendMessageWithDelay(from, errorMessage)));
            }
        } else {
            const timeSincePaymentStart = Date.now() - state.conversationContext.paymentStartTime;
            if (timeSincePaymentStart > 5 * 60 * 1000) {
                const messages = [
                    'Notamos que ainda não recebemos seu comprovante. Se precisar de ajuda ou tiver algum problema, estamos aqui para ajudar! 👍',
                ];
                sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
                state.conversationContext.currentStep = ConversationStep.PaymentReminder;
            }
        }
        this.clientStates.set(from, state);
        return sentMessages;
    }

    private async handleOverpaymentDecision(
        from: string,
        userMessage: string,
        state: UserConversationDTO,
    ): Promise<string[]> {
        const sentMessages = [];
        const excessAmount = state.conversationContext.excessPaymentAmount;

        // Definindo respostas esperadas para as opções
        const addAsTipResponses = ['1', 'adicionar como gorjeta', 'gorjeta', 'adicionar gorjeta'];
        const refundResponses = ['2', 'estorno', 'solicitar estorno', 'extornar'];

        if (addAsTipResponses.some((response) => userMessage.includes(response))) {
            // Usuário escolheu adicionar como gorjeta
            const messages = [
                `🎉 Muito obrigado pela sua generosidade! O valor de *${formatToBRL(excessAmount)}* foi adicionado como gorjeta. 😊`,
                'Estamos felizes por você escolher a *Coti* para facilitar seus pagamentos e apoiar nossa equipe! 🙏',
                'Agora, queremos saber sua opinião! Em uma escala de 0 a 10, o quanto você recomendaria a Coti para amigos ou colegas?\n(0 = nada provável e 10 = muito provável)',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.conversationContext.currentStep = ConversationStep.Feedback;
        } else if (refundResponses.some((response) => userMessage.includes(response))) {
            // Usuário escolheu solicitar o estorno
            const messages = [
                `Entendido! Vamos providenciar o estorno do valor excedente de *${formatToBRL(excessAmount)}* o mais rápido possível. 💸`,
                'Nosso time está aqui para garantir a melhor experiência para você. 😊',
                'Enquanto processamos o estorno, gostaríamos de saber sua opinião! Em uma escala de 0 a 10, o quanto você recomendaria a Coti para amigos ou colegas?\n(0 = nada provável e 10 = muito provável)',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.conversationContext.currentStep = ConversationStep.Feedback;
        } else {
            // Caso o usuário insira uma resposta inválida
            const messages = [
                'Desculpe, não entendi sua resposta.',
                `Por favor, escolha uma das opções abaixo:\n1- Adicionar o valor excedente como gorjeta.\n2- Solicitar o estorno do valor extra.`,
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
        }

        this.clientStates.set(from, state);
        return sentMessages;
    }


    private async handleAwaitingUserDecision(
        from: string,
        userMessage: string,
        state: UserConversationDTO,
    ): Promise<string[]> {
        const sentMessages = [];

        const positiveResponses = ['1', 'nova transação', 'realizar nova transação', 'pagar valor restante'];
        const assistanceResponses = ['2', 'chamar atendente', 'ajuda', 'preciso de ajuda'];

        if (positiveResponses.some((response) => userMessage.includes(response))) {
            // Atualizar o valor necessário para a nova transação
            const remainingAmount =
                state.conversationContext.userAmount
                    .toFixed(2);
            state.conversationContext.userAmount = parseFloat(remainingAmount); // Atualiza o valor necessário com o saldo restante

            const messages = [
                `Valor a ser pago: *${formatToBRL(remainingAmount)}*`,
                'Segue abaixo a chave PIX para pagamento 👇',
                '00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
                'Por favor, envie o comprovante! 📄✅',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.conversationContext.currentStep = ConversationStep.WaitingForPayment;
        } else if (assistanceResponses.some((response) => userMessage.includes(response))) {
            const messages = [
                '👨‍💼 Um de nossos atendentes já está a caminho para te ajudar!',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.conversationContext.currentStep = ConversationStep.PaymentAssistance;
        } else {
            const messages = [
                'Desculpe, não entendi sua resposta.',
                'Por favor, escolha uma das opções abaixo:\n' +
                '1- Pagar valor restante.\n' +
                '2- Chamar um atendente.',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
        }

        this.clientStates.set(from, state);
        return sentMessages;
    }

    // 8. Payment Reminder
    private async handlePaymentReminder(
        from: string,
        userMessage: string,
        state: UserConversationDTO,
    ): Promise<string[]> {
        const sentMessages = [];
        if (userMessage.includes('sim, preciso de ajuda')) {
            const messages = ['Entendido! 😊 Vamos encaminhar um de nossos atendentes para te ajudar.'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            this.clientStates.delete(from); // Remove state
        } else if (userMessage.includes('sim, estou fazendo o pagamento')) {
            const messages = ['Entendido! 😊 Estamos no aguardo.'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.conversationContext.currentStep = ConversationStep.WaitingForPayment;
            this.clientStates.set(from, state);
        } else if (userMessage.includes('não, irei pagar de forma convencional')) {
            const messages = [
                'Que pena! 😔 Se mudar de ideia, estamos por aqui para te ajudar! 😊',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            this.clientStates.delete(from); // Remove state
        } else {
            const messages = [
                'Por favor, nos informe se precisa de ajuda ou se está fazendo o pagamento.',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            this.clientStates.set(from, state);
        }
        return sentMessages; // Return the sent messages
    }

    // 9. Feedback
    private async handleFeedback(
        from: string,
        userMessage: string,
        state: UserConversationDTO,
    ): Promise<string[]> {
        const sentMessages = [];
        const npsScore = parseInt(userMessage);
        if (!isNaN(npsScore) && npsScore >= 0 && npsScore <= 10) {
            if (!state.conversationContext.feedback) {
                state.conversationContext.feedback = new FeedbackDTO();
            }
            state.conversationContext.feedback.npsScore = npsScore;
            if (npsScore < 10) {
                const messages = [
                    'Agradecemos muito pelo Feedback, e queremos sempre melhorar, o que você sente que faltou para o 10?',
                ];
                sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
                state.conversationContext.currentStep = ConversationStep.FeedbackDetail;
            } else {
                const messages = ['Muito obrigado pelo seu feedback! 😊'];
                sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
                state.conversationContext.currentStep = ConversationStep.Completed;
                this.clientStates.delete(from); // Remove state
            }
        } else {
            const messages = ['Por favor, avalie de 0 a 10.'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
        }
        this.clientStates.set(from, state);
        return sentMessages;
    }

    // 10. Feedback Detail
    private async handleFeedbackDetail(
        from: string,
        userMessage: string,
        state: UserConversationDTO,
    ): Promise<string[]> {
        const sentMessages = [];
        const detailedFeedback = userMessage; // Capture the user's detailed feedback
        if (!state.conversationContext.feedback) {
            state.conversationContext.feedback = new FeedbackDTO();
        }
        state.conversationContext.feedback.detailedFeedback = detailedFeedback;
        const messages = [
            'Obrigado pelo seu feedback detalhado! 😊',
            'Se precisar de mais alguma coisa, estamos aqui para ajudar!',
        ];
        sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
        this.logger.log(`User ${from} provided detailed feedback: ${detailedFeedback}`);
        state.conversationContext.currentStep = ConversationStep.Completed;
        this.clientStates.delete(from); // Remove state
        return sentMessages; // Return the sent messages
    }
}
