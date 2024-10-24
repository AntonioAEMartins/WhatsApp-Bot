const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Map to store conversation state per client
const clientStates = new Map();
// Map to store typing timeout for each user
const typingTimeouts = new Map();

const client = new Client({
    authStrategy: new LocalAuth()  // Automatically handles storing session keys
});

client.once('ready', () => {
    console.log('Client is ready!');
});

client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

// Helper function to send messages with a delay between each
const sendMessageWithDelay = async (from, messages, delay = 2000) => {
    for (const msg of messages) {
        await client.sendMessage(from, msg);
        await new Promise(resolve => setTimeout(resolve, delay));
    }
};

client.on('message_create', async message => {
    // Ignore messages sent by the bot itself
    if (message.fromMe) {
        return;
    }

    const contact = await message.getContact();
    const from = contact.id._serialized;
    let state = clientStates.get(from) || {};

    const userMessage = message.body.trim().toLowerCase();

    // Log current state for debugging
    console.log(`User: ${from}, State: ${state.step}, Message: "${userMessage}"`);

    // Handle conversation based on state
    if (!state.step) {
        // Initial step
        if (userMessage.includes('pagar a comanda')) {
            state.step = 'processing_order';
            clientStates.set(from, state);
            message.reply('👋 *Coti Pagamentos* - Que ótimo! Estamos processando sua comanda, por favor aguarde. 😁');

            // Simulate processing and send messages with delay
            setTimeout(async () => {
                const messages = [
                    '🎉 Parabéns! Você ganhou *2% de desconto* na sua conta. Segue o detalhamento',
                    '(🍽️) Prato 1\n1 un. x R$ 50,00 = R$ 50,00\n\n(🍽️) Prato 2\n2 un. x R$ 30,00 = R$ 60,00\n\n-----------------------------------\n\n✨ Taxa de Serviço: R$ 11,00\n💳 Total Bruto: R$ 121,00',
                    '👍 A sua comanda está correta?\n\n1- Sim\n2- Não'
                ];
                await sendMessageWithDelay(from, messages);
                state.step = 'confirm_order';
                clientStates.set(from, state);
            }, 2000);
        } else {
            message.reply('Desculpe, não entendi sua mensagem. Você gostaria de pagar a comanda? Por favor, diga "Gostaria de pagar a comanda X"');
        }
    } else if (state.step === 'confirm_order') {
        if (userMessage === '1' || userMessage.includes('sim')) {
            // Proceed to next step: Ask if the client wants to split the bill
            await sendMessageWithDelay(from, [
                '👍 Você gostaria de dividir a conta?\n\n1- Sim, em partes iguais\n2- Não'
            ]);
            state.step = 'split_bill';
            clientStates.set(from, state);
        } else if (userMessage === '2' || userMessage.includes('não')) {
            // Order is not correct
            await sendMessageWithDelay(from, [
                'Que pena! Lamentamos pelo ocorrido e o atendente responsável irá conversar com você.'
            ]);
            // End conversation
            clientStates.delete(from);
        } else {
            await sendMessageWithDelay(from, [
                'Por favor, responda com 1 para Sim ou 2 para Não.'
            ]);
        }
    } else if (state.step === 'split_bill') {
        if (userMessage === '1' || userMessage.includes('sim')) {
            // Client wants to split the bill
            await sendMessageWithDelay(from, [
                'Ok, gostaria de dividir entre quantas pessoas?\n\nLembrando que apenas suportamos a divisão em partes iguais.'
            ]);
            state.step = 'split_bill_number';
            clientStates.set(from, state);
        } else if (userMessage === '2' || userMessage.includes('não')) {
            // Client does not want to split the bill: Proceed to tip option
            await sendMessageWithDelay(from, [
                'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%'
            ]);
            state.step = 'extra_tip';
            clientStates.set(from, state);
        } else {
            await sendMessageWithDelay(from, [
                'Por favor, responda com 1 para Sim ou 2 para Não.'
            ]);
        }
    } else if (state.step === 'split_bill_number') {
        // Handle number of people
        const numPeople = parseInt(userMessage);
        if (!isNaN(numPeople) && numPeople > 1) {
            state.numPeople = numPeople;
            // Ask for contacts
            await sendMessageWithDelay(from, [
                'Ok, por favor nos envie o contato das pessoas com quem gostaria de dividir ou peça para que elas escaneiem o QR Code da sua mesa!\n\nAssim que recebermos o contato de todos, daremos prosseguimento ao atendimento.'
            ]);
            state.step = 'waiting_for_contacts';
            clientStates.set(from, state);
        } else {
            await sendMessageWithDelay(from, [
                'Por favor, informe um número válido de pessoas (maior que 1).'
            ]);
        }
    } else if (state.step === 'waiting_for_contacts') {
        // For simplicity, let's assume contacts are sent and proceed
        // Notify others (simulate)
        await sendMessageWithDelay(from, [
            '👋 *Coti Pagamentos* - Boa noite! Você foi solicitado para dividir a conta no Cris Parrila.',
        ]);
        // Calculate individual amounts
        const individualAmount = (121 / state.numPeople).toFixed(2);
        await sendMessageWithDelay(from, [
            `Sua parte ficou: *R$ ${individualAmount}*`,
            'Recebido!'
        ]);
        // Proceed to payment (we may need to handle individual payments)
        clientStates.delete(from);
    } else if (state.step === 'extra_tip') {
        if (
            userMessage.includes('não') ||
            userMessage.includes('nao') ||
            userMessage.includes('n quero') ||
            userMessage.includes('não quero') ||
            userMessage.includes('nao quero')
        ) {
            await sendMessageWithDelay(from, [
                'Sem problemas!',
                'O valor final da sua conta foi de: *R$ VALOR_FINAL*',
                'Segue abaixo chave copia e cola do PIX 👇\n\n00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
                'Por favor, envie o comprovante! 📄✅'
            ]);
            state.step = 'waiting_for_payment';
            state.paymentStartTime = Date.now();
            clientStates.set(from, state);
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
                await sendMessageWithDelay(from, [tipResponse]);
                // Proceed to payment
                await sendMessageWithDelay(from, [
                    'O valor final da sua conta foi de: *R$ VALOR_FINAL*',
                    'Segue abaixo chave copia e cola do PIX 👇\n\n00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
                    'Por favor, envie o comprovante! 📄✅'
                ]);
                state.step = 'waiting_for_payment';
                state.paymentStartTime = Date.now();
                clientStates.set(from, state);
            } else {
                // Handle messages outside the expected options
                if (userMessage.includes('já temos a taxa') || userMessage.includes('já temos a taxa certa')) {
                    await sendMessageWithDelay(from, [
                        'A taxa já está inclusa, mas pelo bom serviço, gostaria de adicionar um extra?'
                    ]);
                    // Remain in the same step
                } else {
                    await sendMessageWithDelay(from, [
                        'Por favor, escolha uma das opções de gorjeta: 3%, 5% ou 7%, ou diga que não deseja dar gorjeta.'
                    ]);
                }
            }
        }
    } else if (state.step === 'waiting_for_payment') {
        // Check if the message is the payment confirmation
        if (userMessage.includes('comprovante') || message.hasMedia) {
            // Payment confirmed
            await sendMessageWithDelay(from, [
                'Pagamento confirmado.',
                'Muito obrigado por utilizar a *Coti* e realizar pagamentos mais *rápidos* 🙏',
                'Esperamos que sua experiência tenha sido excelente. Sua satisfação é muito importante para nós e estamos sempre prontos para te atender novamente! 😊',
                'Sua opinião é essencial para nós! Queremos saber:\n\nEm uma escala de 0 a 10, o quanto você recomendaria a Coti para amigos ou colegas?\n(0 = nada provável e 10 = muito provável)'
            ]);
            state.step = 'feedback';
            clientStates.set(from, state);
        } else {
            // Check if 5 minutes have passed
            const timeSincePaymentStart = Date.now() - state.paymentStartTime;
            if (timeSincePaymentStart > 5 * 60 * 1000) { // 5 minutes in milliseconds
                await sendMessageWithDelay(from, [
                    'Notamos que ainda não recebemos seu comprovante. Se precisar de ajuda ou tiver algum problema, estamos aqui para ajudar! 👍'
                ]);
                state.step = 'payment_reminder';
                clientStates.set(from, state);
            } else {
                // Waiting for payment
                // Optionally, you can notify the user that the bot is still waiting
            }
        }
    } else if (state.step === 'payment_reminder') {
        if (userMessage.includes('sim, preciso de ajuda')) {
            await sendMessageWithDelay(from, [
                'Entendido! 😊 Vamos encaminhar um de nossos atendentes para te ajudar.'
            ]);
            clientStates.delete(from);
        } else if (userMessage.includes('sim, estou fazendo o pagamento')) {
            await sendMessageWithDelay(from, [
                'Entendido! 😊 Estamos no aguardo.'
            ]);
            state.step = 'waiting_for_payment';
            clientStates.set(from, state);
        } else if (userMessage.includes('não, irei pagar de forma convencional')) {
            await sendMessageWithDelay(from, [
                'Que pena! 😔 Você vai abrir mão do *DESCONTO*. Se mudar de ideia, estamos por aqui para te ajudar! 😊'
            ]);
            clientStates.delete(from);
        } else {
            await sendMessageWithDelay(from, [
                'Por favor, nos informe se precisa de ajuda ou se está fazendo o pagamento.'
            ]);
        }
    } else if (state.step === 'feedback') {
        const npsScore = parseInt(userMessage);
        // Clear any existing typing timeout
        if (typingTimeouts.has(from)) {
            clearTimeout(typingTimeouts.get(from));
            typingTimeouts.delete(from);
        }

        if (!isNaN(npsScore) && npsScore >= 0 && npsScore <= 10) {
            if (npsScore < 10) {
                await sendMessageWithDelay(from, [
                    'Agradecemos muito pelo Feedback, e queremos sempre melhorar, o que você sente que faltou para o 10?'
                ]);
                state.step = 'feedback_detail';
                clientStates.set(from, state);
            } else {
                // Set a timeout to send a thank you message after the user stops typing
                typingTimeouts.set(from, setTimeout(async () => {
                    await sendMessageWithDelay(from, [
                        'Muito obrigado pelo seu feedback! 😊'
                    ]);
                    clientStates.delete(from);
                }, 3000)); // 3 seconds delay
            }
        } else {
            await sendMessageWithDelay(from, [
                'Por favor, avalie de 0 a 10.'
            ]);
        }
    } else if (state.step === 'feedback_detail') {
        // Collect detailed feedback
        const detailedFeedback = userMessage; // Capture the user's detailed feedback

        await sendMessageWithDelay(from, [
            'Obrigado pelo seu feedback detalhado! 😊',
            'Se precisar de mais alguma coisa, estamos aqui para ajudar!'
        ]);

        // Optional: Store or process detailed feedback here
        console.log(`User ${from} provided detailed feedback: ${detailedFeedback}`);

        // Clear the client state after feedback is collected
        clientStates.delete(from);
    }
});

// Initialize the client
client.initialize();
