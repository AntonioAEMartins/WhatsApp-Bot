import { ConversationDto } from "src/conversation/dto/conversation.dto";
import { formatToBRL } from "./currency.utils";
import { Message } from "whatsapp-web.js";

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

export async function sendPaymentConfirmationToAttendants(state: ConversationDto): Promise<void> {
    const groupName = 'Grupo Teste';

    try {
        const chats = await this.client.getChats();
        const groupChat = chats.find(chat => chat.isGroup && chat.name === groupName);

        if (groupChat) {
            let message = '';

            const orderId = state.conversationContext.paymentDetails.orderId;
            const totalAmount = state.orderDetails.totalAmount;

            if (state.conversationContext.splitInfo && state.conversationContext.splitInfo.numberOfPeople > 1) {
                const splitInfo = state.conversationContext.splitInfo;
                const numberOfPeople = splitInfo.numberOfPeople;
                const contacts = splitInfo.contacts;

                message += `🧾 *Comanda ${orderId}* está sendo paga de forma compartilhada.\n`;
                message += `Total a ser pago: ${formatToBRL(totalAmount)}\n\n`;
                message += `👥 *Divisão entre ${numberOfPeople} pessoas:*\n`;

                const currentUserName = 'Cliente';
                const userAmount = state.conversationContext.userAmount;

                let totalPaidByUser = 0;
                if (state.conversationContext.paymentProofs && state.conversationContext.paymentProofs.length > 0) {
                    totalPaidByUser = state.conversationContext.paymentProofs.reduce((sum, proof) => sum + proof.valor, 0);
                }
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

                        if (contactState.conversationContext.paymentProofs && contactState.conversationContext.paymentProofs.length > 0) {
                            totalPaidByContact = contactState.conversationContext.paymentProofs.reduce((sum, proof) => sum + proof.valor, 0);
                        }

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

                let totalPaidByUser = 0;
                if (state.conversationContext.paymentProofs && state.conversationContext.paymentProofs.length > 0) {
                    totalPaidByUser = state.conversationContext.paymentProofs.reduce((sum, proof) => sum + proof.valor, 0);
                }
                const remainingAmount = userAmount - totalPaidByUser;

                if (remainingAmount > 0) {
                    // Usuário pagou menos do que deveria
                    message += `⚠️ *Comanda ${orderId} paga parcialmente*\n`;
                    message += `• ${currentUserName} deveria pagar: ${formatToBRL(userAmount)}\n`;
                    message += `• Pagou: ${formatToBRL(totalPaidByUser)}\n`;
                    message += `• Restante a pagar: ${formatToBRL(remainingAmount)}\n\n`;
                } else if (remainingAmount < 0) {
                    // Usuário pagou mais do que deveria
                    message += `⚠️ *Comanda ${orderId} paga com valor excedente*\n`;
                    message += `• ${currentUserName} deveria pagar: ${formatToBRL(userAmount)}\n`;
                    message += `• Pagou: ${formatToBRL(totalPaidByUser)}\n`;
                    message += `• Excedente: ${formatToBRL(-remainingAmount)}\n\n`;
                } else {
                    // Pagamento completo
                    message += `✅ *Comanda ${orderId} paga em totalidade*\n`;
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

export async function sendAuthenticationStatusToGroup(message: string): Promise<void> {
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

export async function sendProofToGroup(proofMessage: Message): Promise<void> {
    // Nome do grupo
    const groupName = 'Coti + Cris Parrilla [COMPROVANTES]';

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
