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
    private async sendMessageWithDelay(from: string, messages: string[], delay: number = 2000) {
        for (const msg of messages) {
            await this.client.sendMessage(from, msg);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    // 1. Processing Order
    private async handleProcessingOrder(from: string, state: any) {
        await this.sendMessageWithDelay(from, [
            '(🍽️) Prato 1\n1 un. x R$ 50,00 = R$ 50,00\n\n(🍽️) Prato 2\n2 un. x R$ 30,00 = R$ 60,00\n\n-----------------------------------\n\n✨ Taxa de Serviço: R$ 11,00\n💳 Total Bruto: R$ 121,00',
            '👍 A sua comanda está correta?\n\n1- Sim\n2- Não',
        ]);
        state.step = 'confirm_order';
        this.clientStates.set(from, state);
    }

    // 2. Confirm Order
    private async handleConfirmOrder(from: string, userMessage: string, state: any) {
        if (userMessage === '1' || userMessage.includes('sim')) {
            // Proceed to next step: Ask if the client wants to split the bill
            await this.sendMessageWithDelay(from, [
                '👍 Você gostaria de dividir a conta?\n\n1- Sim, em partes iguais\n2- Não',
            ]);
            state.step = 'split_bill';
        } else if (userMessage === '2' || userMessage.includes('não')) {
            // Order is not correct
            await this.sendMessageWithDelay(from, [
                'Que pena! Lamentamos pelo ocorrido e o atendente responsável irá conversar com você.',
            ]);
            // End conversation
            this.clientStates.delete(from);
            return;
        } else {
            await this.sendMessageWithDelay(from, [
                'Por favor, responda com 1 para Sim ou 2 para Não.',
            ]);
            return;
        }
        this.clientStates.set(from, state);
    }

    // 3. Split Bill
    private async handleSplitBill(from: string, userMessage: string, state: any) {
        if (userMessage === '1' || userMessage.includes('sim')) {
            // Client wants to split the bill
            await this.sendMessageWithDelay(from, [
                'Ok, gostaria de dividir entre quantas pessoas?\n\nLembrando que apenas suportamos a divisão em partes iguais.',
            ]);
            state.step = 'split_bill_number';
        } else if (userMessage === '2' || userMessage.includes('não')) {
            // Client does not want to split the bill: Proceed to tip option
            await this.sendMessageWithDelay(from, [
                'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
            ]);
            state.step = 'extra_tip';
        } else {
            await this.sendMessageWithDelay(from, [
                'Por favor, responda com 1 para Sim ou 2 para Não.',
            ]);
            return;
        }
        this.clientStates.set(from, state);
    }

    // 4. Split Bill Number
    private async handleSplitBillNumber(from: string, userMessage: string, state: any) {
        const numPeople = parseInt(userMessage);
        if (!isNaN(numPeople) && numPeople > 1) {
            state.numPeople = numPeople;
            // Ask for contacts
            await this.sendMessageWithDelay(from, [
                'Ok, por favor nos envie o contato das pessoas com quem gostaria de dividir ou peça para que elas escaneiem o QR Code da sua mesa!\n\nAssim que recebermos o contato de todos, daremos prosseguimento ao atendimento.',
            ]);
            state.step = 'waiting_for_contacts';
        } else {
            await this.sendMessageWithDelay(from, [
                'Por favor, informe um número válido de pessoas (maior que 1).',
            ]);
            return;
        }
        this.clientStates.set(from, state);
    }

    // 5. Waiting for Contacts
    private async handleWaitingForContacts(from: string, state: any) {
        // For simplicity, let's assume contacts are sent and proceed
        // Notify others (simulate)
        await this.sendMessageWithDelay(from, [
            '👋 *Coti Pagamentos* - Boa noite! Você foi solicitado para dividir a conta no Cris Parrila.',
        ]);
        // Calculate individual amounts
        const individualAmount = (121 / state.numPeople).toFixed(2);
        await this.sendMessageWithDelay(from, [
            `Sua parte ficou: *R$ ${individualAmount}*`,
            'Recebido!',
        ]);
        // Proceed to payment (we may need to handle individual payments)
        this.clientStates.delete(from);
    }

    // 6. Extra Tip
    private async handleExtraTip(from: string, userMessage: string, state: any) {
        const noTipKeywords = ['não', 'nao', 'n quero', 'não quero', 'nao quero'];
        if (noTipKeywords.some((keyword) => userMessage.includes(keyword))) {
            await this.sendMessageWithDelay(from, [
                'Sem problemas!',
                'O valor final da sua conta foi de: *R$ VALOR_FINAL*',
                'Segue abaixo chave copia e cola do PIX 👇\n\n00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
                'Por favor, envie o comprovante! 📄✅',
            ]);
            state.step = 'waiting_for_payment';
            state.paymentStartTime = Date.now();
        } else {
            // Assume the user selected a percentage
            const tipPercent = parseFloat(userMessage.replace('%', ''));
            if (!isNaN(tipPercent)) {
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
                await this.sendMessageWithDelay(from, [tipResponse]);
                // Proceed to payment
                await this.sendMessageWithDelay(from, [
                    'O valor final da sua conta foi de: *R$ VALOR_FINAL*',
                    'Segue abaixo chave copia e cola do PIX 👇\n\n00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
                    'Por favor, envie o comprovante! 📄✅',
                ]);
                state.step = 'waiting_for_payment';
                state.paymentStartTime = Date.now();
            } else {
                // Handle messages outside the expected options
                if (userMessage.includes('já temos a taxa') || userMessage.includes('já temos a taxa certa')) {
                    await this.sendMessageWithDelay(from, [
                        'A taxa já está inclusa, mas pelo bom serviço, gostaria de adicionar um extra?',
                    ]);
                    // Remain in the same step
                    return;
                } else {
                    await this.sendMessageWithDelay(from, [
                        'Por favor, escolha uma das opções de gorjeta: 3%, 5% ou 7%, ou diga que não deseja dar gorjeta.',
                    ]);
                    return;
                }
            }
        }
        this.clientStates.set(from, state);
    }

    // 7. Waiting for Payment
    private async handleWaitingForPayment(from: string, userMessage: string, state: any, message: Message) {
        if (userMessage.includes('comprovante') || message.hasMedia) {
            // Payment confirmed
            await this.sendMessageWithDelay(from, [
                'Pagamento confirmado.',
                'Muito obrigado por utilizar a *Coti* e realizar pagamentos mais *rápidos* 🙏',
                'Esperamos que sua experiência tenha sido excelente. Sua satisfação é muito importante para nós e estamos sempre prontos para te atender novamente! 😊',
                'Sua opinião é essencial para nós! Queremos saber:\n\nEm uma escala de 0 a 10, o quanto você recomendaria a Coti para amigos ou colegas?\n(0 = nada provável e 10 = muito provável)',
            ]);
            state.step = 'feedback';
            this.clientStates.set(from, state);
        } else {
            // Check if 5 minutes have passed
            const timeSincePaymentStart = Date.now() - state.paymentStartTime;
            if (timeSincePaymentStart > 5 * 60 * 1000) {
                await this.sendMessageWithDelay(from, [
                    'Notamos que ainda não recebemos seu comprovante. Se precisar de ajuda ou tiver algum problema, estamos aqui para ajudar! 👍',
                ]);
                state.step = 'payment_reminder';
                this.clientStates.set(from, state);
            } else {
                // Waiting for payment
                // Optionally, you can notify the user that the bot is still waiting
            }
        }
    }

    // 8. Payment Reminder
    private async handlePaymentReminder(from: string, userMessage: string, state: any) {
        if (userMessage.includes('sim, preciso de ajuda')) {
            await this.sendMessageWithDelay(from, [
                'Entendido! 😊 Vamos encaminhar um de nossos atendentes para te ajudar.',
            ]);
            this.clientStates.delete(from);
        } else if (userMessage.includes('sim, estou fazendo o pagamento')) {
            await this.sendMessageWithDelay(from, [
                'Entendido! 😊 Estamos no aguardo.',
            ]);
            state.step = 'waiting_for_payment';
            this.clientStates.set(from, state);
        } else if (userMessage.includes('não, irei pagar de forma convencional')) {
            await this.sendMessageWithDelay(from, [
                'Que pena! 😔 Se mudar de ideia, estamos por aqui para te ajudar! 😊',
            ]);
            this.clientStates.delete(from);
        } else {
            await this.sendMessageWithDelay(from, [
                'Por favor, nos informe se precisa de ajuda ou se está fazendo o pagamento.',
            ]);
        }
    }

    // 9. Feedback
    private async handleFeedback(from: string, userMessage: string, state: any) {
        const npsScore = parseInt(userMessage);
        // Clear any existing typing timeout
        if (this.typingTimeouts.has(from)) {
            clearTimeout(this.typingTimeouts.get(from));
            this.typingTimeouts.delete(from);
        }

        if (!isNaN(npsScore) && npsScore >= 0 && npsScore <= 10) {
            if (npsScore < 10) {
                await this.sendMessageWithDelay(from, [
                    'Agradecemos muito pelo Feedback, e queremos sempre melhorar, o que você sente que faltou para o 10?',
                ]);
                state.step = 'feedback_detail';
                this.clientStates.set(from, state);
            } else {
                // Set a timeout to send a thank you message after the user stops typing
                this.typingTimeouts.set(from, setTimeout(async () => {
                    await this.sendMessageWithDelay(from, [
                        'Muito obrigado pelo seu feedback! 😊',
                    ]);
                    this.clientStates.delete(from);
                }, 3000)); // 3 seconds delay
            }
        } else {
            await this.sendMessageWithDelay(from, [
                'Por favor, avalie de 0 a 10.',
            ]);
        }
    }

    // 10. Feedback Detail
    private async handleFeedbackDetail(from: string, userMessage: string, state: any) {
        // Collect detailed feedback
        const detailedFeedback = userMessage; // Capture the user's detailed feedback

        await this.sendMessageWithDelay(from, [
            'Obrigado pelo seu feedback detalhado! 😊',
            'Se precisar de mais alguma coisa, estamos aqui para ajudar!',
        ]);

        // Optional: Store or process detailed feedback here
        this.logger.log(`User ${from} provided detailed feedback: ${detailedFeedback}`);

        // Clear the client state after feedback is collected
        this.clientStates.delete(from);
    }
}
