import { ConversationDto, ConversationStep, MessageDTO, MessageType } from "src/conversation/dto/conversation.dto";


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

export function extractOrderId(message: string): string | null {
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

export async function isOrderBeingProcessed(
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

export async function retryRequestWithNotification(
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

export function getDelayMessage(
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

export async function sendMessageWithDelay(
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

export function generateStageErrorMessage(currentStep: ConversationStep): string {
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

export function calculateUserAmount(state: ConversationDto): number {
    const totalAmount = state.orderDetails.totalAmount;

    if (!state.conversationContext.splitInfo) {
        state.conversationContext.splitInfo = { numberOfPeople: 1, contacts: [] };
    }

    const numPeople = state.conversationContext.splitInfo.numberOfPeople || 1;
    return parseFloat((totalAmount / numPeople).toFixed(2));
}