// src/whatsapp/whatsapp.service.ts

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';

@Injectable()
export class WhatsAppService implements OnModuleInit {
    private client: Client;
    private readonly logger = new Logger(WhatsAppService.name);

    // Maps to store conversation state and typing timeouts per client
    private clientStates: Map<string, any> = new Map();
    private typingTimeouts: Map<string, NodeJS.Timeout> = new Map();

    constructor() {
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

    private initializeClient() {
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

            // Calculate message age to avoid processing old messages
            const currentTime = Math.floor(Date.now() / 1000); // Get current time in seconds
            const messageAge = currentTime - message.timestamp; // Message timestamp is in seconds
            const maxAllowedAge = 10; // 5 minutes (300 seconds)

            if (messageAge > maxAllowedAge) {
                this.logger.debug(`Ignoring old message from ${message.from}: ${message.body}`);
                return; // Ignore message if it's older than 5 minutes
            }

            const contact = await message.getContact();
            const from = contact.id._serialized;
            let state = this.clientStates.get(from) || {};

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
                    await this.handleWaitingForContacts(from, state);
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
                    // Not used in this refactored version; can be removed or implemented as needed
                    break;

                default:
                    // Handle initial interaction or undefined states
                    if (userMessage.includes('pagar a comanda')) {
                        state.step = 'processing_order';
                        this.clientStates.set(from, state);
                        await message.reply('👋 *Coti Pagamentos* - Que ótimo! Estamos processando sua comanda, por favor aguarde. 😁');

                        // Simulate processing and send messages with delay
                        setTimeout(async () => {
                            await this.handleProcessingOrder(from, state);
                        }, 2000);
                    } else {
                        await message.reply(
                            'Desculpe, não entendi sua mensagem. Você gostaria de pagar a comanda? Por favor, diga "Gostaria de pagar a comanda X"',
                        );
                    }
                    break;
            }
        });

        this.client.initialize();
    }


    // Helper function to send messages with a delay between each
    private async sendMessageWithDelay(from: string, messages: string[], delay: number = 2000): Promise<string[]> {
        const sentMessages = [];
        for (const msg of messages) {
            await this.client.sendMessage(from, msg);
            sentMessages.push(msg); // Track the message being sent
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
        return sentMessages; // Return the list of messages sent
    }


    // 1. Processing Order
    private async handleProcessingOrder(from: string, state: any): Promise<string[]> {
        const messages = [
            '(🍽️) Prato 1\n1 un. x R$ 50,00 = R$ 50,00\n\n(🍽️) Prato 2\n2 un. x R$ 30,00 = R$ 60,00\n\n-----------------------------------\n\n✨ Taxa de Serviço: R$ 11,00\n💳 Total Bruto: R$ 121,00',
            '👍 A sua comanda está correta?\n\n1- Sim\n2- Não',
        ];
        const sentMessages = await this.sendMessageWithDelay(from, messages);
        state.step = 'confirm_order';
        this.clientStates.set(from, state);
        return sentMessages; // Return the sent messages
    }

    // 2. Confirm Order
    private async handleConfirmOrder(from: string, userMessage: string, state: any): Promise<string[]> {
        const sentMessages = [];
        const positiveResponses = ['1', 'sim', 'correta', 'está correta', 'sim está correta'];
        const negativeResponses = ['2', 'não', 'nao', 'não está correta', 'incorreta', 'não correta'];

        if (positiveResponses.some(response => userMessage.includes(response))) {
            const messages = [
                '👍 Você gostaria de dividir a conta?\n\n1- Sim, em partes iguais\n2- Não',
            ];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
            state.step = 'split_bill';
        } else if (negativeResponses.some(response => userMessage.includes(response))) {
            const messages = [
                'Que pena! Lamentamos pelo ocorrido e o atendente responsável irá conversar com você.',
            ];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
            this.clientStates.delete(from);
        } else {
            const messages = [
                'Por favor, responda com 1 para Sim ou 2 para Não.',
            ];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
        }
        this.clientStates.set(from, state);
        return sentMessages;
    }


    // 3. Split Bill
    private async handleSplitBill(from: string, userMessage: string, state: any): Promise<string[]> {
        const sentMessages = [];
        const positiveResponses = ['1', 'sim', 'quero dividir', 'dividir', 'sim dividir', 'partes iguais'];
        const negativeResponses = ['2', 'não', 'nao', 'não quero dividir', 'não dividir'];
    
        if (positiveResponses.some(response => userMessage.includes(response))) {
            const messages = [
                'Ok, gostaria de dividir entre quantas pessoas?\n\nLembrando que apenas suportamos a divisão em partes iguais.',
            ];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
            state.step = 'split_bill_number';
        } else if (negativeResponses.some(response => userMessage.includes(response))) {
            const messages = [
                'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
            ];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
            state.step = 'extra_tip';
        } else {
            const messages = [
                'Por favor, responda com 1 para Sim ou 2 para Não.',
            ];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
        }
        this.clientStates.set(from, state);
        return sentMessages;
    }


    // 4. Split Bill Number
    private async handleSplitBillNumber(from: string, userMessage: string, state: any): Promise<string[]> {
        const sentMessages = [];
        const numPeople = parseInt(userMessage);
        if (!isNaN(numPeople) && numPeople > 1) {
            state.numPeople = numPeople;
            const messages = [
                'Ok, por favor nos envie o contato das pessoas com quem gostaria de dividir ou peça para que elas escaneiem o QR Code da sua mesa!\n\nAssim que recebermos o contato de todos, daremos prosseguimento ao atendimento.',
            ];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
            state.step = 'waiting_for_contacts';
        } else {
            const messages = [
                'Por favor, informe um número válido de pessoas (maior que 1).',
            ];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
        }
        this.clientStates.set(from, state);
        return sentMessages; // Return the sent messages
    }

    // 5. Waiting for Contacts
    private async handleWaitingForContacts(from: string, state: any): Promise<string[]> {
        const sentMessages = [];
        const messages = [
            '👋 *Coti Pagamentos* - Boa noite! Você foi solicitado para dividir a conta no Cris Parrila.',
            `Sua parte ficou: *R$ ${(121 / state.numPeople).toFixed(2)}*`,
            'Recebido!',
        ];
        sentMessages.push(...await this.sendMessageWithDelay(from, messages));
        this.clientStates.delete(from); // Clear state after completion
        return sentMessages; // Return the sent messages
    }


    // 6. Extra Tip
    private async handleExtraTip(from: string, userMessage: string, state: any): Promise<string[]> {
        const sentMessages = [];
        const noTipKeywords = ['não', 'nao', 'n quero', 'não quero', 'nao quero'];
        const tipPercent = parseFloat(userMessage.replace('%', ''));
    
        if (noTipKeywords.some((keyword) => userMessage.includes(keyword)) || tipPercent === 0) {
            const messages = [
                'Sem problemas!',
                'O valor final da sua conta foi de: *R$ VALOR_FINAL*',
                'Segue abaixo chave copia e cola do PIX 👇\n\n00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
                'Por favor, envie o comprovante! 📄✅',
            ];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
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
    
            const paymentMessages = [
                'O valor final da sua conta foi de: *R$ VALOR_FINAL*',
                'Segue abaixo chave copia e cola do PIX 👇\n\n00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
                'Por favor, envie o comprovante! 📄✅',
            ];
            sentMessages.push(...await this.sendMessageWithDelay(from, paymentMessages));
            state.step = 'waiting_for_payment';
            state.paymentStartTime = Date.now();
        } else {
            const messages = [
                'Por favor, escolha uma das opções de gorjeta: 3%, 5% ou 7%, ou diga que não deseja dar gorjeta.',
            ];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
        }
    
        this.clientStates.set(from, state);
        return sentMessages;
    }


    // 7. Waiting for Payment
    private async handleWaitingForPayment(from: string, userMessage: string, state: any, message: Message): Promise<string[]> {
        const sentMessages = [];
        if (userMessage.includes('comprovante') || message.hasMedia) {
            const messages = [
                'Pagamento confirmado.',
                'Muito obrigado por utilizar a *Coti* e realizar pagamentos mais *rápidos* 🙏',
                'Esperamos que sua experiência tenha sido excelente. Sua satisfação é muito importante para nós e estamos sempre prontos para te atender novamente! 😊',
                'Sua opinião é essencial para nós! Queremos saber:\n\nEm uma escala de 0 a 10, o quanto você recomendaria a Coti para amigos ou colegas?\n(0 = nada provável e 10 = muito provável)',
            ];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
            state.step = 'feedback';
        } else {
            const timeSincePaymentStart = Date.now() - state.paymentStartTime;
            if (timeSincePaymentStart > 5 * 60 * 1000) {
                const messages = [
                    'Notamos que ainda não recebemos seu comprovante. Se precisar de ajuda ou tiver algum problema, estamos aqui para ajudar! 👍',
                ];
                sentMessages.push(...await this.sendMessageWithDelay(from, messages));
                state.step = 'payment_reminder';
            }
        }
        this.clientStates.set(from, state);
        return sentMessages; // Return the sent messages
    }


    // 8. Payment Reminder
    private async handlePaymentReminder(from: string, userMessage: string, state: any): Promise<string[]> {
        const sentMessages = [];
        if (userMessage.includes('sim, preciso de ajuda')) {
            const messages = ['Entendido! 😊 Vamos encaminhar um de nossos atendentes para te ajudar.'];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
            this.clientStates.delete(from);
        } else if (userMessage.includes('sim, estou fazendo o pagamento')) {
            const messages = ['Entendido! 😊 Estamos no aguardo.'];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
            state.step = 'waiting_for_payment';
        } else if (userMessage.includes('não, irei pagar de forma convencional')) {
            const messages = [
                'Que pena! 😔 Se mudar de ideia, estamos por aqui para te ajudar! 😊',
            ];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
            this.clientStates.delete(from);
        } else {
            const messages = [
                'Por favor, nos informe se precisa de ajuda ou se está fazendo o pagamento.',
            ];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
        }
        this.clientStates.set(from, state);
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
                sentMessages.push(...await this.sendMessageWithDelay(from, messages));
                state.step = 'feedback_detail';
            } else {
                const messages = ['Muito obrigado pelo seu feedback! 😊'];
                sentMessages.push(...await this.sendMessageWithDelay(from, messages));
                this.clientStates.delete(from);
            }
        } else {
            const messages = ['Por favor, avalie de 0 a 10.'];
            sentMessages.push(...await this.sendMessageWithDelay(from, messages));
        }
        this.clientStates.set(from, state);
        return sentMessages; // Return the sent messages
    }


    // 10. Feedback Detail
    private async handleFeedbackDetail(from: string, userMessage: string, state: any): Promise<string[]> {
        const sentMessages = [];
        const detailedFeedback = userMessage; // Capture the user's detailed feedback
        const messages = [
            'Obrigado pelo seu feedback detalhado! 😊',
            'Se precisar de mais alguma coisa, estamos aqui para ajudar!',
        ];
        sentMessages.push(...await this.sendMessageWithDelay(from, messages));
        this.logger.log(`User ${from} provided detailed feedback: ${detailedFeedback}`);
        this.clientStates.delete(from);
        return sentMessages; // Return the sent messages
    }

}
