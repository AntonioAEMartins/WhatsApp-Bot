// src/whatsapp/whatsapp.service.ts

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import * as vcardParser from 'vcard-parser';
import * as qrcode from 'qrcode-terminal';
import { TableService } from 'src/table/table.service';

@Injectable()
export class WhatsAppService implements OnModuleInit {
    private client: Client;
    private readonly logger = new Logger(WhatsAppService.name);

    // Maps to store conversation state per client
    private clientStates: Map<string, any> = new Map();
    private debugMode = process.env.DEBUG === 'true';

    constructor(private readonly tableService: TableService) {
        // Initialize the WhatsApp client with LocalAuth for persistent sessions
        this.client = new Client({
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

            // Only respond if the number is 551132803247@c.us or 5511993109344@c.us
            if (message.from !== '551132803247@c.us' && message.from !== '5511993109344@c.us') {
                this.logger.debug(`Ignoring message from ${message.from}: ${message.body}`);
                return;
            }


            // Calculate message age to avoid processing old messages
            const currentTime = Math.floor(Date.now() / 1000); // Get current time in seconds
            const messageAge = currentTime - message.timestamp; // Message timestamp is in seconds
            const maxAllowedAge = 10; // 10 seconds

            if (messageAge > maxAllowedAge) {
                this.logger.debug(`Ignoring old message from ${message.from}: ${message.body}`);
                return; // Ignore message if it's older than 10 seconds
            }

            const contact = await message.getContact();
            const from = contact.id._serialized;
            let state = this.clientStates.get(from) || { receivedContacts: 0 };

            const userMessage = message.body.trim().toLowerCase();

            // Log current state for debugging
            this.logger.debug(`User: ${from}, State: ${state.step}, Message: "${userMessage}"`);

            switch (state.step) {
                case 'processing_order':
                    // Currently processing order; no user input expected
                    break;

                case 'confirm_order':
                    await this.handleConfirmOrder(from, userMessage, state);
                    break;

                case 'split_bill':
                    await this.handleSplitBill(from, userMessage, state);
                    break;

                case 'split_bill_number':
                    await this.handleSplitBillNumber(from, userMessage, state);
                    break;

                case 'waiting_for_contacts':
                    await this.handleWaitingForContacts(from, state, message);
                    break;

                case 'extra_tip':
                    await this.handleExtraTip(from, userMessage, state);
                    break;

                case 'waiting_for_payment':
                    await this.handleWaitingForPayment(from, userMessage, state, message);
                    break;

                case 'payment_reminder':
                    await this.handlePaymentReminder(from, userMessage, state);
                    break;

                case 'feedback':
                    await this.handleFeedback(from, userMessage, state);
                    break;

                case 'feedback_detail':
                    await this.handleFeedbackDetail(from, userMessage, state);
                    break;

                case 'completed':
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

                            if (['split_bill', 'split_bill_number', 'waiting_for_contacts'].includes(otherState.step)) {
                                await message.reply(
                                    `Sua comanda está em processo de divisão de conta. O número *${userNumber}* está compartilhando os contatos para dividir a conta. Por favor, aguarde ou entre em contato com essa pessoa para participar da divisão.`
                                );
                            } else {
                                await message.reply(
                                    'Desculpe, esta comanda já está sendo processada por outra pessoa.'
                                );
                            }
                            return;
                        }

                        state.step = 'processing_order';
                        state.order_id = order_id;
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
    private isOrderBeingProcessed(order_id: string, from: string): { isProcessing: boolean; state?: any; userNumber?: string } {
        for (const [otherFrom, otherState] of this.clientStates.entries()) {
            if (
                otherState.order_id === order_id &&
                otherFrom !== from &&
                otherState.step !== 'completed' &&
                otherState.step !== 'incomplete_order'
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
        state: any,
        order_id: number,
    ): Promise<string[]> {
        try {
            const orderData = await this.tableService.orderMessage(order_id);
            console.log("orderData", orderData);
            const orderMessage = orderData.message;
            const orderDetails = orderData.details;

            const messages = [
                orderMessage,
                '👍 A sua comanda está correta?\n\n1- Sim\n2- Não',
            ];
            const sentMessages = await this.sendMessageWithDelay(from, messages);
            state.step = 'confirm_order';
            state.orderDetails = orderDetails;
            this.clientStates.set(from, state);
            return sentMessages; // Return the sent messages
        } catch (error) {
            const messages = [
                'Desculpe, não foi possível encontrar a comanda. Por favor, verifique o número e tente novamente.',
            ];
            const sentMessages = await this.sendMessageWithDelay(from, messages);
            state.step = 'order_not_found';
            this.clientStates.set(from, state);
            return sentMessages;
        }
    }

    // 2. Confirm Order
    private async handleConfirmOrder(from: string, userMessage: string, state: any): Promise<string[]> {
        const sentMessages = [];
        const positiveResponses = ['1', 'sim', 'correta', 'está correta', 'sim está correta'];
        const negativeResponses = ['2', 'não', 'nao', 'não está correta', 'incorreta', 'não correta'];

        if (positiveResponses.some((response) => userMessage.includes(response))) {
            const messages = [
                '👍 Você gostaria de dividir a conta?\n\n1- Sim, em partes iguais\n2- Não',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.step = 'split_bill';
        } else if (negativeResponses.some((response) => userMessage.includes(response))) {
            const messages = [
                'Que pena! Lamentamos pelo ocorrido e o atendente responsável irá conversar com você.',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.step = 'incomplete_order';
            this.clientStates.delete(from); // Remove state
        } else {
            const messages = ['Por favor, responda com 1 para Sim ou 2 para Não.'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
        }
        this.clientStates.set(from, state);
        return sentMessages;
    }

    // 3. Split Bill
    private async handleSplitBill(from: string, userMessage: string, state: any): Promise<string[]> {
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
            state.step = 'split_bill_number';
        } else if (negativeResponses.some((response) => userMessage.includes(response))) {
            const messages = [
                'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.step = 'extra_tip';
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
        state: any,
    ): Promise<string[]> {
        const sentMessages = [];

        // Extract the first number found in the message
        const numPeopleMatch = userMessage.match(/\d+/); //TODO: Limitation: Only the first number is considered and there isn't considered the case where the user sends a number in words
        console.log("numPeopleMatch", numPeopleMatch);
        const numPeople = numPeopleMatch ? parseInt(numPeopleMatch[0]) : NaN;
        console.log("numPeople", numPeople);

        if (!isNaN(numPeople) && numPeople > 1) {
            state.numPeople = numPeople;
            const messages = [
                'Ok, por favor nos envie o contato das pessoas com quem gostaria de dividir ou peça para que elas escaneiem o QR Code da sua mesa!\n\nAssim que recebermos o contato de todos, daremos prosseguimento ao atendimento.',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.step = 'waiting_for_contacts';
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
        state: any,
        message: Message,
    ): Promise<string[]> {
        const sentMessages = [];

        if (message.type === 'vcard' || message.type === 'multi_vcard') {
            try {
                const vcardDataArray = message.vCards;
                let responseMessage = `✨ *Contato(s) Recebido(s) com Sucesso!* ✨\n`;

                for (const vcardData of vcardDataArray) {
                    console.log("vcardData", vcardData);

                    const vcardName = vcardData.split('FN:')[1].split('\n')[0];
                    let vcardPhone = vcardData.split('waid=')[1].split(':')[1].split('\n')[0];
                    vcardPhone = vcardPhone.replace(/\D/g, ''); // Remove all non-numeric characters

                    state.receivedContacts = state.receivedContacts || 0;
                    state.receivedContacts += 1;

                    // Store the received contact
                    if (!state.contacts) state.contacts = [];
                    state.contacts.push({ name: vcardName, phone: vcardPhone });

                    // Append each contact’s details to the response message
                    responseMessage += `\n👤 *Nome:* ${vcardName}\n📞 *Número:* ${vcardPhone}\n`;
                }

                // Calculate remaining contacts after processing all received contacts
                const remainingContacts = (state.numPeople - 1) - state.receivedContacts;

                // If more contacts are still needed, inform the user
                if (remainingContacts > 0) {
                    responseMessage += `\n🕒 Aguardando mais *${remainingContacts}* contato(s) para continuar.`;
                }

                sentMessages.push(...(await this.sendMessageWithDelay(from, [responseMessage])));

                // If all required contacts have been received, proceed to the next step
                if (remainingContacts <= 0) {
                    const completionMessage = '🎉 Todos os contatos foram recebidos! Vamos prosseguir com seu atendimento. 😄';
                    sentMessages.push(...(await this.sendMessageWithDelay(from, [completionMessage])));
                    state.step = 'extra_tip'; // Next step for the main client

                    // Calculate each client's share
                    const totalAmount = state.orderDetails.total;
                    const numPeople = state.numPeople;
                    const userAmount = (totalAmount / numPeople).toFixed(2);

                    // Set individual amount for the main client
                    state.userAmount = parseFloat(userAmount);

                    // Initiate interaction with secondary clients
                    for (const contact of state.contacts) {
                        console.log("HandleWaitingForContacts - Contact", contact);
                        const contactId = `${contact.phone}@c.us`;
                        const contactState = {
                            step: 'extra_tip',
                            order_id: state.order_id,
                            userAmount: parseFloat(userAmount),
                            orderDetails: state.orderDetails,
                        };
                        this.clientStates.set(contactId, contactState);

                        // Send initial message to secondary client
                        const messages = [
                            `👋 Coti Pagamentos - Olá! Você foi incluído na divisão do pagamento da comanda *${state.order_id}* no restaurante Cris Parrilla. Aguarde para receber mais informações sobre o pagamento.`,
                            `Sua parte na conta é de *R$ ${userAmount}*.`,
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
            console.log("Message Type", message.type);
            const promptMessages = [
                '📲 Por favor, envie o contato da pessoa com quem deseja dividir a conta.',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, promptMessages)));
        }

        this.clientStates.set(from, state);
        return sentMessages;
    }


    // 6. Extra Tip
    private async handleExtraTip(from: string, userMessage: string, state: any): Promise<string[]> {
        const sentMessages = [];
        const noTipKeywords = ['não', 'nao', 'n quero', 'não quero', 'nao quero'];
        const tipPercent = parseFloat(userMessage.replace('%', '').replace(',', '.'));
        const userAmount = state.numPeople > 1 ? state.userAmount : state.orderDetails.total.toFixed(2);

        if (noTipKeywords.some((keyword) => userMessage.includes(keyword)) || tipPercent === 0) {
            const messages = [
                'Sem problemas!',
                `O valor final da sua conta é: *R$ ${userAmount}*`,
                'Segue abaixo a chave PIX para pagamento 👇\n\n00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
                'Por favor, envie o comprovante! 📄✅',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.step = 'waiting_for_payment';
            state.paymentStartTime = Date.now();
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

            const totalAmountWithTip = (
                parseFloat(userAmount) *
                (1 + tipPercent / 100)
            ).toFixed(2);

            const paymentMessages = [
                `O valor final da sua conta é: *R$ ${totalAmountWithTip}*`,
                'Segue abaixo a chave PIX para pagamento 👇\n\n00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
                'Por favor, envie o comprovante! 📄✅',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, paymentMessages)));
            state.step = 'waiting_for_payment';
            state.paymentStartTime = Date.now();
        } else {
            const messages = [
                'Por favor, escolha uma das opções de gorjeta: 3%, 5% ou 7%, ou diga que não deseja dar gorjeta.',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
        }

        this.clientStates.set(from, state);
        return sentMessages;
    }



    // 7. Waiting for Payment
    private async handleWaitingForPayment(
        from: string,
        userMessage: string,
        state: any,
        message: Message,
    ): Promise<string[]> {
        const sentMessages = [];
        if (userMessage.includes('comprovante') || message.hasMedia) {
            const messages = [
                'Pagamento confirmado.',
                'Muito obrigado por utilizar a *Coti* e realizar pagamentos mais *rápidos* 🙏',
                'Esperamos que sua experiência tenha sido excelente. Sua satisfação é muito importante para nós e estamos sempre prontos para te atender novamente! 😊',
                'Sua opinião é essencial para nós! Queremos saber:\n\nEm uma escala de 0 a 10, o quanto você recomendaria a Coti para amigos ou colegas?\n(0 = nada provável e 10 = muito provável)',
            ];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.step = 'feedback';
        } else {
            const timeSincePaymentStart = Date.now() - state.paymentStartTime;
            if (timeSincePaymentStart > 5 * 60 * 1000) {
                const messages = [
                    'Notamos que ainda não recebemos seu comprovante. Se precisar de ajuda ou tiver algum problema, estamos aqui para ajudar! 👍',
                ];
                sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
                state.step = 'payment_reminder';
            }
        }
        this.clientStates.set(from, state);
        return sentMessages; // Return the sent messages
    }

    // 8. Payment Reminder
    private async handlePaymentReminder(
        from: string,
        userMessage: string,
        state: any,
    ): Promise<string[]> {
        const sentMessages = [];
        if (userMessage.includes('sim, preciso de ajuda')) {
            const messages = ['Entendido! 😊 Vamos encaminhar um de nossos atendentes para te ajudar.'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            this.clientStates.delete(from); // Remove state
        } else if (userMessage.includes('sim, estou fazendo o pagamento')) {
            const messages = ['Entendido! 😊 Estamos no aguardo.'];
            sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
            state.step = 'waiting_for_payment';
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
    private async handleFeedback(from: string, userMessage: string, state: any): Promise<string[]> {
        const sentMessages = [];
        const npsScore = parseInt(userMessage);
        if (!isNaN(npsScore) && npsScore >= 0 && npsScore <= 10) {
            if (npsScore < 10) {
                const messages = [
                    'Agradecemos muito pelo Feedback, e queremos sempre melhorar, o que você sente que faltou para o 10?',
                ];
                sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
                state.step = 'feedback_detail';
            } else {
                const messages = ['Muito obrigado pelo seu feedback! 😊'];
                sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
                state.step = 'completed';
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
        state: any,
    ): Promise<string[]> {
        const sentMessages = [];
        const detailedFeedback = userMessage; // Capture the user's detailed feedback
        const messages = [
            'Obrigado pelo seu feedback detalhado! 😊',
            'Se precisar de mais alguma coisa, estamos aqui para ajudar!',
        ];
        sentMessages.push(...(await this.sendMessageWithDelay(from, messages)));
        this.logger.log(`User ${from} provided detailed feedback: ${detailedFeedback}`);
        state.step = 'completed';
        this.clientStates.delete(from); // Remove state
        return sentMessages; // Return the sent messages
    }
}
