// /**
//  * This file contains all the credit card payment related functions that were removed
//  * from the main message.service.ts file when implementing the PIX-only version.
//  * 
//  * These functions are kept here for reference and can be reintegrated if credit card
//  * payment functionality is needed in the future.
//  */

// import { Injectable, Logger, Inject, HttpException, HttpStatus, forwardRef } from '@nestjs/common';
// // Import statements would go here in a real implementation

// /**
//  * Step: Payment Method Selection
//  * 
//  * Handles the user's selection of a payment method (PIX or Credit Card).
//  */
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
//                     footerText: "Para excluir um cartão salvo, digite: *deletar <número>*`
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
//                 { id: "payment_credit", title: "Cartão de Crédito" }
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

// /**
//  * Step: Select Saved Card
//  * 
//  * Handles the user's selection of a saved credit card or option to use a new card.
//  */
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

// /**
//  * Step: Handle Credit Card Payment
//  * 
//  * Manages the credit card payment process.
//  */
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