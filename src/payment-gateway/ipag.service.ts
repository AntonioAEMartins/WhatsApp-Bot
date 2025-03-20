import { HttpException, HttpStatus, Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { CreatePaymentDto, LibraryCardType, PaymentMethodCard, PaymentMethodPix, PaymentType, UserPaymentCreditInfoDto, UserPaymentPixInfoDto } from './dto/ipag-pagamentos.dto';
import { IPagErrorResponse, IPagTransactionResponse } from './types/ipag-response.types';
import { CreateEstablishmentDto, CreateSellerDto } from './dto/ipag-marketplace.dto';
import { TransactionService } from 'src/transaction/transaction.service';
import { PaymentStatus } from 'src/conversation/dto/conversation.enums';
import * as crypto from 'crypto';
import { SimpleResponseDto } from 'src/request/request.dto';
import { ConversationService } from 'src/conversation/conversation.service';
import { ErrorDescriptionDTO, PaymentMethod, PaymentProcessorDTO, TransactionDTO } from 'src/transaction/dto/transaction.dto';
import { CardService } from 'src/card/card.service';
import * as payform from 'payform';
import { MessageService } from 'src/message/message.service';

@Injectable()
export class IPagService {
    private readonly baseURL: string;
    private readonly apiId: string;
    private readonly apiKey: string;
    private readonly ipagSplitSellerId: string;
    private readonly logger = new Logger(IPagService.name);

    constructor(
        private readonly transactionService: TransactionService,
        private readonly conversationService: ConversationService,
        private readonly cardService: CardService,
        @Inject(forwardRef(() => MessageService)) private readonly messageService: MessageService
    ) {
        // You can set these values using environment variables for security
        this.ipagSplitSellerId = process.env.ENVIRONMENT === 'development' ? process.env.IPAG_DEV_VENDOR : process.env.ENVIRONMENT === 'homologation' ? process.env.IPAG_DEV_VENDOR : process.env.IPAG_CP_VENDOR;
        const ipagBaseUrl = process.env.ENVIRONMENT === 'development' ? process.env.IPAG_BASE_DEV_URL : process.env.ENVIRONMENT === 'homologation' ? process.env.IPAG_BASE_DEV_URL : process.env.IPAG_BASE_PROD_URL;
        const ipagApiKey = process.env.ENVIRONMENT === 'development' ? process.env.IPAG_API_DEV_KEY : process.env.ENVIRONMENT === 'homologation' ? process.env.IPAG_API_DEV_KEY : process.env.IPAG_API_PROD_KEY;
        this.baseURL = ipagBaseUrl || 'https://api.ipag.com.br';
        this.apiId = process.env.IPAG_API_ID
        this.apiKey = ipagApiKey
    }

    // Function to create the Authorization header for HTTP Basic Auth
    private getAuthHeader(): string {
        const credentials = `${this.apiId}:${this.apiKey}`;
        return `Basic ${Buffer.from(credentials).toString('base64')}`;
    }

    // Example function to make authenticated requests
    async makeRequest(endpoint: string, method: 'GET' | 'POST', data?: any): Promise<IPagTransactionResponse | IPagErrorResponse> {
        try {
            const headers = {
                Authorization: this.getAuthHeader(),
                'Content-Type': 'application/json',
                'x-api-version': '2',
            };

            console.log("iPag baseURL", this.baseURL);

            const response = await fetch(`${this.baseURL}/${endpoint}`, {
                method,
                headers,
                body: data ? JSON.stringify(data) : undefined,
            });

            if (!response.ok) {
                if (response.status === 401) {
                    console.error('Unauthorized: Check your API credentials.');
                }
                throw new HttpException(`HTTP Error: ${response.status}`, HttpStatus.BAD_REQUEST);
            }

            return await response.json();
        } catch (error) {
            console.error('Error in IPagService:', error);
            throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
        }
    }

    async createPIXPayment(
        userPaymentInfo: UserPaymentPixInfoDto,
    ): Promise<IPagTransactionResponse> {
        // In demo mode, create a mock PIX key without going through the payment gateway
        if (process.env.ENVIRONMENT === 'demo') {
            this.logger.log(`[createPIXPayment] DEMO MODE - Creating mock PIX for transaction ${userPaymentInfo.transactionId}`);

            // Get the transaction to fetch the expected amount
            const transaction = await this.transactionService.getTransaction(userPaymentInfo.transactionId);
            const expectedAmount = transaction.data.expectedAmount;

            // Generate a mock PIX QR code that looks similar to real one
            const mockQRCode = `00020101021126580014br.gov.bcb.demo.mock.pix.key@demo.com5204000053039865802BR5913DEMO MOCK6009SAO PAULO62290525${this.generateRandomString(20)}6304${this.generateRandomString(4)}`;

            // Schedule automatic completion after 10 seconds
            setTimeout(async () => {
                try {
                    // Garantindo que o método simulateTransactionCompletion seja chamado no contexto correto
                    await this.simulateTransactionCompletion(userPaymentInfo.transactionId);
                    this.logger.log(`[createPIXPayment] DEMO MODE - Auto-completed transaction ${userPaymentInfo.transactionId}`);
                } catch (error) {
                    this.logger.error(`[createPIXPayment] DEMO MODE - Error auto-completing transaction: ${error.message}`);
                }
            }, 10000);

            const now = new Date();

            return {
                id: 123456,
                uuid: `demo-${this.generateRandomString(10)}`,
                resource: 'transaction',
                attributes: {
                    history: [],
                    seller_id: 'demo-seller',
                    order_id: transaction.data.orderId,
                    amount: expectedAmount,
                    installments: 1,
                    tid: `demo-${this.generateRandomString(8)}`,
                    authorization_id: `demo-auth-${this.generateRandomString(6)}`,
                    status: { code: 1, message: 'pending' },
                    method: 'pix',
                    captured_amount: 0,
                    captured_at: '',
                    url_authentication: '',
                    callback_url: '',
                    created_at: now.toISOString(),
                    updated_at: now.toISOString(),
                    acquirer: { name: 'demo', message: 'Waiting for payment', code: '00', merchant_id: 'demo-merchant' },
                    gateway: { code: 'P0', message: 'Success' },
                    pix: {
                        link: `https://sandbox.payment.link/${userPaymentInfo.transactionId}`,
                        qrcode: mockQRCode
                    },
                    customer: {
                        name: userPaymentInfo.customerInfo.name,
                        cpf_cnpj: userPaymentInfo.customerInfo.cpf_cnpj,
                        email: userPaymentInfo.customerInfo.email || '',
                        phone: userPaymentInfo.customerInfo.phone || '',
                        billing_address: {
                            street: '',
                            number: '',
                            district: '',
                            complement: '',
                            city: '',
                            state: '',
                            zipcode: '',
                            country: 'BR'
                        },
                        shipping_address: {
                            street: '',
                            number: '',
                            district: '',
                            complement: '',
                            city: '',
                            state: '',
                            zipcode: '',
                            country: 'BR'
                        }
                    },
                    products: []
                },

            };
        }

        // Regular production/homologation/development flow
        const endpoint = '/service/payment';
        // Valida a transação para PIX – se não estiver Pending e for Failed, cria nova transação e continua;
        // se estiver em outro status, lança exceção.
        console.log("[createPIXPayment] userPaymentInfo", userPaymentInfo);
        const transaction = await this.validateTransaction(
            userPaymentInfo.transactionId,
            PaymentMethod.PIX,
            true,
        );
        console.log("[createPIXPayment] transaction", transaction);

        const paymentData: CreatePaymentDto = {
            amount: transaction.expectedAmount,
            callback_url: 'https://webhook.astra1.com.br/ipag/callback',
            payment: {
                type: PaymentType.pix,
                method: PaymentMethodPix.pix,
                pix_expires_in: userPaymentInfo.pixExpiresIn,
                installments: 1,
                softdescriptor: 'ASTRA-BAR-CRISP',
            },
            customer: {
                name: userPaymentInfo.customerInfo.name.substring(0, 80),
                cpf_cnpj: userPaymentInfo.customerInfo.cpf_cnpj,
            },
            // split_rules: [
            //     {
            //         seller_id: this.ipagSplitSellerId,
            //         percentage: 100,
            //     },
            // ],
        };

        console.log("[createPIXPayment] paymentData", paymentData);

        try {
            const response = (await this.makeRequest(
                endpoint,
                'POST',
                paymentData,
            )) as IPagTransactionResponse;

            await this.transactionService.updateTransaction(userPaymentInfo.transactionId, {
                ipagTransactionId: response.uuid,
                pixInfo: {
                    name: userPaymentInfo.customerInfo.name,
                    document: userPaymentInfo.customerInfo.cpf_cnpj,
                },
            });

            return response;
        } catch (error) {
            console.log("[createPIXPayment] error", error);
            if (error instanceof HttpException) {
                const processedResponse = this.processTransactionResponse(error.getResponse());
                if (processedResponse.type !== 'success') {
                    throw new HttpException(this.getUserFriendlyPaymentError(processedResponse.type, processedResponse.erros[0]), HttpStatus.BAD_REQUEST);
                }
            }
            throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
        }
    }

    async createCreditCardPayment(
        userPaymentInfo: UserPaymentCreditInfoDto,
    ): Promise<SimpleResponseDto<{ msg: string }>> {
        // Verificação de ambiente sandbox
        if (process.env.ENVIRONMENT === 'demo') {
            this.logger.log(`[createCreditCardPayment] DEMO MODE - Processing credit card payment for transaction ${userPaymentInfo.transactionId}`);

            const transaction = await this.validateTransaction(
                userPaymentInfo.transactionId,
                PaymentMethod.CREDIT_CARD,
                false,
            );

            let cardNumber: string;

            if (userPaymentInfo.cardId) {
                const existingCardResponse = await this.cardService.getCardById(userPaymentInfo.cardId);
                if (!existingCardResponse?.data) {
                    throw new HttpException('Card not found', HttpStatus.BAD_REQUEST);
                }
                cardNumber = existingCardResponse.data.last4;
            } else {
                cardNumber = userPaymentInfo.cardInfo.number.slice(-4);
            }

            // Pegar o último dígito
            const lastDigit = parseInt(cardNumber.slice(-1));
            const isOdd = lastDigit % 2 !== 0;

            this.logger.log(`[createCreditCardPayment] DEMO MODE - Last digit: ${lastDigit}, isOdd: ${isOdd}`);

            // Se o último dígito for par, simulamos rejeição
            if (!isOdd) {
                await this.transactionService.updateTransaction(userPaymentInfo.transactionId, {
                    errorDescription: {
                        errorCode: 'demo-rejection',
                        userFriendlyMessage: 'Cartão com final par rejeitado em ambiente demo',
                        rawError: 'Demo mode: even-ending cards are always rejected',
                    },
                    status: PaymentStatus.Denied,
                });

                // Dispara processo de falha (mesma lógica usada nos fluxos reais)
                const conversation = await this.conversationService.getConversation(transaction.conversationId);
                const paymentProcessorDTO: PaymentProcessorDTO = {
                    transactionId: transaction._id.toString(),
                    from: conversation.data.userId,
                    state: conversation.data,
                };
                
                await this.messageService.processPayment(paymentProcessorDTO);

                throw new HttpException('Cartão com final par rejeitado em ambiente demo', HttpStatus.BAD_REQUEST);
            }

            // Se chegou aqui, o último dígito é ímpar, simulamos aprovação
            const now = new Date();
            const mockTransactionId = `demo-${this.generateRandomString(10)}`;

            // Dispara processo de conclusão (mesma lógica usada nos fluxos reais)
            console.log("Antes do Get Conversation");
            const conversation = await this.conversationService.getConversation(transaction.conversationId);
            console.log("Depois do Get Conversation");
            const paymentProcessorDTO: PaymentProcessorDTO = {
                transactionId: transaction._id.toString(),
                from: conversation.data.userId,
                state: conversation.data,
            };

            let cardId: string | undefined;

            console.log("userPaymentInfo.cardId", userPaymentInfo.cardId);
            console.log("userPaymentInfo.saveCard", userPaymentInfo.saveCard);

            // If user is using an existing card, use that card ID
            if (userPaymentInfo.cardId) {
                cardId = userPaymentInfo.cardId;
            } else {
                // Always create a card record for transaction tracking
                const createdCardResponse = await this.cardService.createCard({
                    userId: transaction.userId,
                    holder: {
                        name: userPaymentInfo.customerInfo.name,
                        document: userPaymentInfo.customerInfo.cpf_cnpj,
                    },
                    brand: this.getCardMethod(userPaymentInfo.cardInfo.number),
                    last4: cardNumber,
                    // Only generate a token if the user wants to save the card
                    token: userPaymentInfo.saveCard ? `demo-token-${this.generateRandomString(8)}` : null,
                    expiry_month: userPaymentInfo.cardInfo.expiry_month,
                    expiry_year: userPaymentInfo.cardInfo.expiry_year,
                });
                
                cardId = createdCardResponse.data._id;
                console.log("Created card ID:", cardId);
            }

            this.logger.log(`[createCreditCardPayment] DEMO MODE - Card ID: ${cardId}`);

            await this.transactionService.updateTransaction(userPaymentInfo.transactionId, {
                ipagTransactionId: mockTransactionId,
                amountPaid: transaction.expectedAmount,
                status: PaymentStatus.Accepted,
                confirmedAt: now,
                cardId: cardId,
            });

            this.logger.log(`[createCreditCardPayment] DEMO MODE - Payment processor DTO: ${JSON.stringify(paymentProcessorDTO)}`);

            this.messageService.processPayment(paymentProcessorDTO);

            this.logger.log(`[createCreditCardPayment] DEMO MODE - Payment created`);

            return {
                msg: 'Payment created',
                data: { msg: 'Payment created' },
            };
        }

        // Regular production/homologation/development flow
        const transaction = await this.validateTransaction(
            userPaymentInfo.transactionId,
            PaymentMethod.CREDIT_CARD,
            false,
        );

        const isTokenized = Boolean(userPaymentInfo.cardId);
        let cardPayload: any;
        let cardBrand: PaymentMethodCard | null = null;
        let holderName: string;
        let holderDocument: string;

        if (isTokenized) {
            const existingCardResponse = await this.cardService.getCardById(userPaymentInfo.cardId);
            if (!existingCardResponse?.data) {
                throw new HttpException('Card not found', HttpStatus.BAD_REQUEST);
            }
            cardPayload = { token: existingCardResponse.data.token };
            holderName = existingCardResponse.data.holderName;
            holderDocument = existingCardResponse.data.holderDocument;
        } else {
            cardBrand = this.getCardMethod(userPaymentInfo.cardInfo.number);
            cardPayload = {
                holder: userPaymentInfo.cardInfo.holder.substring(0, 50),
                number: userPaymentInfo.cardInfo.number,
                expiry_month: userPaymentInfo.cardInfo.expiry_month,
                expiry_year: userPaymentInfo.cardInfo.expiry_year,
                cvv: userPaymentInfo.cardInfo.cvv,
                tokenize: userPaymentInfo.saveCard,
            };
            holderName = userPaymentInfo.customerInfo.name.substring(0, 80);
            holderDocument = userPaymentInfo.customerInfo.cpf_cnpj;
        }

        // Constrói o payload de pagamento conforme a documentação do iPag.
        const paymentData: CreatePaymentDto = {
            amount: transaction.expectedAmount,
            callback_url: 'https://webhook.astra1.com.br/ipag/callback',
            payment: {
                type: PaymentType.card,
                method: cardBrand,
                installments: 1,
                softdescriptor: 'ASTRA-BAR-CRISP',
                card: cardPayload,
                capture: true,
            },
            customer: {
                name: holderName,
                cpf_cnpj: holderDocument,
            },

            // split_rules: [
            //     {
            //         seller_id: this.ipagSplitSellerId,
            //         percentage: 100,
            //     },
            // ],
        };

        console.log("[createCreditCardPayment] paymentData", paymentData);

        try {
            console.log("[createCreditCardPayment] paymentData", paymentData);

            // Cria a transação no iPag
            const response = await this.makeRequest('service/payment', 'POST', paymentData);
            console.log("[createCreditCardPayment] response", response);

            // Verifica se a resposta do iPag é válida
            if (!this.isTransactionResponse(response)) {
                throw new HttpException('Invalid transaction response', HttpStatus.BAD_REQUEST);
            }

            // Processa a resposta para checar status (capturado, pré-autorizado etc.)
            const processedResponse = this.processTransactionResponse(response);

            // Se o status não for 'success', 'pre_authorized', 'waiting' ou 'created', trata como erro
            if (
                processedResponse.type !== 'success' &&
                processedResponse.type !== 'pre_authorized' &&
                processedResponse.type !== 'waiting' &&
                processedResponse.type !== 'created'
            ) {
                // Atualiza a transação com status de erro
                await this.transactionService.updateTransaction(userPaymentInfo.transactionId, {
                    ipagTransactionId: response.uuid,
                    status: PaymentStatus.Denied,
                    errorDescription: {
                        errorCode: processedResponse.type,
                        userFriendlyMessage: this.getUserFriendlyPaymentError(processedResponse.type, processedResponse.erros[0]),
                        rawError: JSON.stringify(processedResponse.erros),
                    },
                });

                // Dispara processo de falha
                const conversation = await this.conversationService.getConversation(transaction.conversationId);
                const paymentProcessorDTO: PaymentProcessorDTO = {
                    transactionId: transaction._id.toString(),
                    from: conversation.data.userId,
                    state: conversation.data,
                };
                await this.messageService.processPayment(paymentProcessorDTO);

                throw new HttpException(
                    this.getUserFriendlyPaymentError(processedResponse.type, processedResponse.erros[0]),
                    HttpStatus.BAD_REQUEST,
                );
            }

            // Cria o cartão, caso não seja tokenizado e o cliente deseje salvá-lo
            let createdCard;
            if (!isTokenized) {
                createdCard = await this.cardService.createCard({
                    userId: transaction.userId,
                    holder: {
                        name: userPaymentInfo.customerInfo.name,
                        document: userPaymentInfo.customerInfo.cpf_cnpj,
                    },
                    brand: cardBrand,
                    last4: userPaymentInfo.cardInfo.number.slice(-4),
                    token: userPaymentInfo.saveCard ? response.attributes.card.token : null,
                    expiry_month: userPaymentInfo.cardInfo.expiry_month,
                    expiry_year: userPaymentInfo.cardInfo.expiry_year,
                });
            }

            // Atualiza a transação com o ID interno da iPag e o ID do cartão
            const finalCardId = userPaymentInfo.cardId || createdCard?.data?._id;
            await this.transactionService.updateTransaction(userPaymentInfo.transactionId, {
                ipagTransactionId: response.uuid,
                cardId: finalCardId,
            });

            // Função auxiliar para finalizar pagamento com status "Accepted"
            const finalizePayment = async () => {
                const transactionRecord = await this.transactionService.getTransaction(userPaymentInfo.transactionId);
                const conversationRecord = await this.conversationService.getConversation(transactionRecord.data.conversationId);

                // Marca a transação como aceita
                await this.transactionService.updateTransaction(userPaymentInfo.transactionId, {
                    amountPaid: response.attributes.amount,
                    status: PaymentStatus.Accepted,
                    confirmedAt: new Date(),
                });

                // Dispara a fila, caso necessário
                const paymentProcessorDTO: PaymentProcessorDTO = {
                    transactionId: transactionRecord.data._id.toString(),
                    from: conversationRecord.data.userId,
                    state: conversationRecord.data,
                };
                await this.messageService.processPayment(paymentProcessorDTO);
            };

            // Se o status vier como "success" (capturado), já finaliza
            if (processedResponse.type === 'success') {
                await finalizePayment();
            }
            // Se vier como "pre_authorized", faz a captura e, se concluído, finaliza
            else if (processedResponse.type === 'pre_authorized') {
                const captureResp = await this.capturePayment(response.uuid);
                const captureProcessed = this.processTransactionResponse(captureResp);

                if (captureProcessed.type === 'success') {
                    await finalizePayment();
                } else {
                    // Se a captura falhar, atualiza a transação e processa o erro
                    await this.transactionService.updateTransaction(userPaymentInfo.transactionId, {
                        status: PaymentStatus.Denied,
                        errorDescription: {
                            errorCode: captureProcessed.type,
                            userFriendlyMessage: this.getUserFriendlyPaymentError(captureProcessed.type, captureProcessed.erros[0]),
                            rawError: JSON.stringify(captureProcessed.erros),
                        },
                    });

                    // Dispara processo de falha
                    const conversation = await this.conversationService.getConversation(transaction.conversationId);
                    const paymentProcessorDTO: PaymentProcessorDTO = {
                        transactionId: transaction._id.toString(),
                        from: conversation.data.userId,
                        state: conversation.data,
                    };
                    await this.messageService.processPayment(paymentProcessorDTO);
                }
            }
            // Se for "waiting" ou "created", não fazemos nada extra agora (aguardando callback ou fluxo futuro)

            return {
                msg: 'Payment created',
                data: { msg: 'Payment created' },
            };
        } catch (error) {
            console.error('Error creating payment:', error);
            
            // Se ainda não processamos o erro, atualizamos a transação e notificamos
            if (!(error instanceof HttpException)) {
                await this.transactionService.updateTransaction(userPaymentInfo.transactionId, {
                    status: PaymentStatus.Denied,
                    errorDescription: {
                        errorCode: 'unknown_error',
                        userFriendlyMessage: 'Ocorreu um erro ao processar o pagamento',
                        rawError: error.message || JSON.stringify(error),
                    },
                });

                // Dispara processo de falha
                const conversation = await this.conversationService.getConversation(transaction.conversationId);
                const paymentProcessorDTO: PaymentProcessorDTO = {
                    transactionId: transaction._id.toString(),
                    from: conversation.data.userId,
                    state: conversation.data,
                };
                await this.messageService.processPayment(paymentProcessorDTO);
            }
            
            if (error instanceof HttpException) {
                throw error;
            }
            throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
        }
    }

    /**
     * Valida a transação com base no ID e no método de pagamento.
     * 
     * Para ambos os métodos:
     * - Se a transação não for encontrada, lança erro.
     * - Se o status não for Pending:
     *    - Se for Failed, cria uma nova transação com status Pending.
     *      - Para PIX, a nova transação é utilizada e o fluxo continua.
     *      - Para Cartão de Crédito, após criar a nova transação, lança exceção.
     *    - Caso contrário, lança exceção imediatamente.
     * 
     * @param transactionId ID da transação
     * @param paymentMethod Método de pagamento (PIX ou CREDIT_CARD)
     * @param isPix Flag que indica se é uma transação PIX (true) ou não (false)
     */
    private async validateTransaction(
        transactionId: string,
        paymentMethod: PaymentMethod,
        isPix: boolean,
    ): Promise<TransactionDTO> {
        let transaction = await this.transactionService.getTransaction(transactionId);

        if (!transaction) {
            throw new HttpException('Transação não encontrada', HttpStatus.NOT_FOUND);
        }

        if (transaction.data.status !== PaymentStatus.Pending) {
            throw new HttpException('Transação não está pendente', HttpStatus.BAD_REQUEST);
        }

        return transaction.data;
    }

    /**
     * Processa os dados da transação (callback) de forma granular e retorna
     * um JSON com a propriedade "type" e "erros", considerando erros do Gateway,
     * do Adquirente (incluindo status) ou sucesso.
     *
     * Critérios:
     * - Gateway: O código deve ser 'P0', 'F0' ou 'F1'. Caso contrário, retorna erro do tipo "Gateway".
     * - Acquirer: O código deve ser "00". **Caso o código seja vazio, mas a mensagem for "CONCLUIDA", é considerado sucesso.**
     * - Status: Espera-se que o código seja 8 (por exemplo, "CAPTURED"). Caso contrário, também será classificado como erro do tipo "acquirer".
     *
     * @param response Dados da transação (callback)
     * @returns JSON com { type: string, erros: string[] }
     */
    private processTransactionResponse(response: any): { type: string; erros: string[] } {
        if (!response || !response.attributes) {
            return { type: "acquirer", erros: ["Dados da transação inválidos."] };
        }

        const { gateway, acquirer, status } = response.attributes;

        if (!gateway || !gateway.code) {
            return { type: "Gateway", erros: ["Código do Gateway ausente ou inválido."] };
        }

        if (gateway.code === "P5" && gateway.message && gateway.message.toLowerCase().includes("quarentena")) {
            const match = gateway.message.match(/return code:\s*(\w+)/i);
            if (match) {
                const extractedCode = match[1];
                if (!extractedCode.startsWith("P")) {
                    return { type: "acquirer", erros: [`Código: ${extractedCode}`] };
                }
            }
            return { type: "Gateway", erros: [`Código: ${gateway.code}`] };
        }

        if (gateway.code.startsWith("P") && !["P0", "F0", "F1"].includes(gateway.code)) {
            return { type: "Gateway", erros: [`Código: ${gateway.code}`] };
        }

        if (!status || typeof status.code === "undefined") {
            return { type: "acquirer", erros: ["Status da transação ausente."] };
        }

        if (status.code === 1) {
            return { type: "created", erros: [] };
        }

        if (status.code === 2) {
            return { type: "waiting", erros: [] };
        }

        if (status.code === 3) {
            if (!acquirer) {
                return { type: "acquirer", erros: ["Dados do adquirente ausentes."] };
            }
            const acquirerCode = (acquirer.code ?? "").trim();
            const acquirerMessage = (acquirer.message ?? "").trim().toUpperCase();
            if (
                acquirerCode === "00" ||
                (acquirerCode === "" && (acquirerMessage === "CONCLUIDA" || acquirerMessage === "SUCESSO"))
            ) {
                return { type: "canceled", erros: [] };
            }
            return { type: "acquirer", erros: [`Código: ${acquirerCode || "indefinido"}`] };
        }

        if (status.code === 5) {
            if (!acquirer) {
                return { type: "acquirer", erros: ["Dados do adquirente ausentes."] };
            }
            const acquirerCode = (acquirer.code ?? "").trim();
            const acquirerMessage = (acquirer.message ?? "").trim().toUpperCase();
            if (
                acquirerCode === "00" ||
                (acquirerCode === "" && (acquirerMessage === "CONCLUIDA" || acquirerMessage === "SUCESSO"))
            ) {
                return { type: "pre_authorized", erros: [] };
            }
            return { type: "acquirer", erros: [`Código: ${acquirerCode || "indefinido"}`] };
        }

        if (status.code === 8) {
            if (!acquirer) {
                return { type: "acquirer", erros: ["Dados do adquirente ausentes."] };
            }
            const acquirerCode = (acquirer.code ?? "").trim();
            const acquirerMessage = (acquirer.message ?? "").trim().toUpperCase();
            if (
                acquirerCode === "00" ||
                (acquirerCode === "" && acquirerMessage === "CONCLUIDA")
            ) {
                return { type: "success", erros: [] };
            }
            return { type: "acquirer", erros: [`Código: ${acquirerCode || "indefinido"}`] };
        }

        if (acquirer && acquirer.code) {
            return { type: "acquirer", erros: [`Código: ${acquirer.code}`] };
        }

        return { type: "acquirer", erros: [status.message || "Transação não capturada."] };
    }

    /**
   * Endpoint para receber callbacks do iPag.
   * 
   * Processa os dados do callback recebidos, validando a origem, os headers e a assinatura por meio da subfunção validateCallback.
   * Em seguida, utiliza a lógica já existente (processTransactionResponse) para interpretar a transação.
   *
   * @param callbackData O JSON já _parseado_ do callback.
   * @param rawBody O corpo bruto da requisição.
   * @param headers Os headers da requisição.
   * @param ipAddress O endereço IP de onde a requisição se originou.
   * @returns Um objeto com { type: string, errors: string[] } indicando sucesso ou erro na transação.
   * @throws HttpException caso algum requisito não seja atendido.
   */
    async processCallback(
        callbackData: IPagTransactionResponse | IPagErrorResponse,
        rawBody: string,
        headers: any,
        ipAddress: string,
    ): Promise<{ type: string; errors: string[] }> {
        try {
            console.log("[processCallback] callbackData", callbackData);
            // Validate IP, required headers, and signature
            this.validateCallback(ipAddress, headers, rawBody);

            console.log("[processCallback] callbackData (after validation)", callbackData);
            // Process the callback using existing logic
            const result = this.processTransactionResponse(callbackData);

            console.log("[processCallback] result", result);

            // Ajuste principal: permitir "pre_authorized".
            if (result.type === "success" || result.type === "pre_authorized") {
                if (this.isTransactionResponse(callbackData)) {
                    console.log("[processCallback] callbackData isTransactionResponse", callbackData);
                    const transaction = await this.transactionService.getTransactionByipagTransactionId(callbackData.uuid);
                    const conversation = await this.conversationService.getConversation(transaction.data.conversationId);

                    if (transaction.data.status !== PaymentStatus.Pending && transaction.data.status !== PaymentStatus.PreAuthorized) {
                        console.warn('[processCallback] Transaction not pending, ignoring callback');
                        return { type: "error", errors: ["Transaction not pending."] };
                    }

                    if (result.type === "success") {
                        // Pagamento efetivamente capturado
                        await this.transactionService.updateTransaction(transaction.data._id.toString(), {
                            status: PaymentStatus.Accepted,
                            amountPaid: callbackData.attributes.amount,
                            confirmedAt: new Date(),
                        });

                        const paymentProcessorDTO: PaymentProcessorDTO = {
                            transactionId: transaction.data._id.toString(),
                            from: conversation.data.userId,
                            state: conversation.data,
                        };

                        // Dispara fluxo de "aceite" ou próximo passo no funil
                        await this.messageService.processPayment(paymentProcessorDTO);
                        return { type: "success", errors: [] };
                    } else {
                        await this.transactionService.updateTransaction(transaction.data._id.toString(), {
                            status: PaymentStatus.PreAuthorized,
                            updatedAt: new Date(),
                        });

                        const captureResponse = await this.capturePayment(callbackData.uuid);

                        console.log("[processCallback] captureResponse", captureResponse);

                        return { type: "pre_authorized", errors: [] };
                    }
                } else {
                    return { type: "error", errors: ["Callback does not contain valid transaction data."] };
                }
            } else {
                // Significa que result.type === "Gateway", "acquirer", "canceled", etc.
                if (result.type === "Gateway" || result.type === "acquirer") {
                    if (this.isTransactionResponse(callbackData)) {
                        const transaction = await this.transactionService.getTransactionByipagTransactionId(callbackData.uuid);
                        if (transaction.data.status === PaymentStatus.Pending) {
                            const errorDescription: ErrorDescriptionDTO = {
                                errorCode: result.type,
                                userFriendlyMessage: this.getUserFriendlyPaymentError(result.type, result.erros[0]),
                                rawError: result.erros.join(' '),
                            };
                            await this.transactionService.updateTransaction(transaction.data._id.toString(), {
                                errorDescription: errorDescription,
                                status: PaymentStatus.Denied,
                            });
                            await this.transactionService.duplicateTransaction(transaction.data._id.toString());
                        }
                    }
                }
                return { type: "error", errors: result.erros };
            }
        } catch (error) {
            console.error('Error handling callback:', error);
            // Retorna um erro genérico. Normalmente callbacks esperam HTTP 2xx,
            // para não gerar novas tentativas infinitas, etc.
            return { type: "error", errors: [error.message || "Unexpected error occurred."] };
        }
    }

    isTransactionResponse(
        data: IPagTransactionResponse | IPagErrorResponse
    ): data is IPagTransactionResponse {
        return (data as IPagTransactionResponse).uuid !== undefined
            && (data as IPagTransactionResponse).attributes !== undefined;
    }

    async createSeller(createSeller: CreateSellerDto): Promise<any> {
        const endpoint = 'service/resources/sellers';
        try {
            const response = await this.makeRequest(endpoint, 'POST', createSeller);
            return response;
        } catch (error) {
            console.error('Error creating seller:', error);
            if (error instanceof HttpException) {
                throw error;
            }
            throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
        }
    }

    async createEstablishment(createEstablishment: CreateEstablishmentDto): Promise<any> {
        const endpoint = 'service/resources/establishments';
        try {
            const response = await this.makeRequest(endpoint, 'POST', createEstablishment);
            return response;
        } catch (error) {
            console.error('Error creating establishment:', error);
            if (error instanceof HttpException) {
                throw error;
            }
            throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
        }
    }

    getCardMethod(cardNumber: string): PaymentMethodCard | null {
        if (!cardNumber) {
            return null;
        }

        cardNumber = cardNumber.replace(/[\s-]/g, '');

        const libResult = payform.parseCardType(cardNumber) as LibraryCardType | null;
        console.log("[getCardMethod] Library result:", libResult);

        const libToPaymentMap: Record<LibraryCardType, PaymentMethodCard | null> = {
            [LibraryCardType.visa]: PaymentMethodCard.visa,
            [LibraryCardType.mastercard]: PaymentMethodCard.mastercard,
            [LibraryCardType.elo]: PaymentMethodCard.elo,
            [LibraryCardType.amex]: PaymentMethodCard.amex,
            [LibraryCardType.diners]: PaymentMethodCard.diners,
            [LibraryCardType.discover]: PaymentMethodCard.discover,
            [LibraryCardType.hipercard]: PaymentMethodCard.hipercard,
            [LibraryCardType.hiper]: PaymentMethodCard.hiper,
            [LibraryCardType.jcb]: PaymentMethodCard.jcb,
            [LibraryCardType.aura]: PaymentMethodCard.aura,
            [LibraryCardType.visaelectron]: PaymentMethodCard.visaelectron,
            [LibraryCardType.maestro]: PaymentMethodCard.maestro,
            [LibraryCardType.dankort]: null,
            [LibraryCardType.forbrugsforeningen]: null,
            [LibraryCardType.laser]: null,
        };

        const mappedLibResult = libResult ? libToPaymentMap[libResult] : null;

        let regexResult: PaymentMethodCard | null = null;
        const cardPatterns: { [key: string]: RegExp } = {
            elo: /^(?:4011\d{12}|431274\d{10}|438935\d{10}|451416\d{10}|457393\d{10}|45763[1-2]\d{10}|504175\d{10}|506699\d{10}|5067(?:[0-6]\d|7[0-8])\d{9}|509\d{3}\d{10}|627780\d{10}|636297\d{10}|636368\d{10}|636369\d{10}|6500(?:3[1-3]|3[5-9]|4\d|5[0-1])\d{10}|650(?:4(?:0[5-9]|\d{2})|5(?:[0-2]\d|3[0-8]|4[1-9]|[5-8]\d|9[0-8]))\d{10}|6507(?:0\d|1[0-8]|2[0-7])\d{10}|6509(?:0[1-9]|1\d|20)\d{10}|6516(?:5[2-9]|[6-7]\d)\d{10}|6550(?:[0-1]\d|2[1-9]|[3-4]\d|5[0-8])\d{10})$/,
            visa: /^4[0-9]{12}(?:[0-9]{3})?$/,
            mastercard: /^(?:5[1-5][0-9]{14}|2(?:2[2-9][0-9]{2}|[3-6][0-9]{3}|7[01][0-9]{2}|720)[0-9]{12})$/,
            amex: /^3[47][0-9]{13}$/,
            discover: /^6(?:011|5[0-9]{2})[0-9]{12}$/,
            diners: /^3(?:0[0-5]|[68][0-9])[0-9]{11}$/,
            jcb: /^(?:2131|1800|35\d{3})\d{11}$/,
            hipercard: /^(606282\d{10}(\d{3})?|3841\d{15}|637\d{13})$/,
            aura: /^50[0-9]{14,17}$/,
            maestro: /^(5018|5020|5038|5893|6304|6759|676[1-3])\d{8,15}$/,
        };

        for (const [brand, pattern] of Object.entries(cardPatterns)) {
            if (pattern.test(cardNumber)) {
                regexResult = brand as PaymentMethodCard;
                break;
            }
        }

        return mappedLibResult ? mappedLibResult : regexResult;
    }

    /**
     * Valida os dados do callback: IP de origem, headers obrigatórios e assinatura.
     * 
     * @param ipAddress O endereço IP de onde a requisição se originou.
     * @param headers Os headers da requisição.
     * @param rawBody O corpo bruto da requisição (formato compacto, UTF-8).
     * @throws HttpException se alguma das validações falhar.
     */
    private validateCallback(ipAddress: string, headers: any, rawBody: string): void {
        console.log("[validateCallback] ipAddress", ipAddress);
        console.log("[validateCallback] headers", headers);
        console.log("[validateCallback] rawBody", rawBody);
        // 1. Validação do endereço IP (libera apenas os IPs autorizados pelo iPag)
        const allowedIPs = ['52.73.203.226', '184.73.165.27', '3.95.238.214'];
        if (!allowedIPs.includes(ipAddress)) {
            throw new HttpException('Unauthorized IP address', HttpStatus.FORBIDDEN);
        }

        // 2. Verificação dos headers obrigatórios
        const signature = headers['x-ipag-signature'] || headers['X-Ipag-Signature'];
        if (!signature) {
            throw new HttpException('Missing X-Ipag-Signature header', HttpStatus.BAD_REQUEST);
        }
        const event = headers['x-ipag-event'] || headers['X-Ipag-Event'];
        const timestamp = headers['x-ipag-timestamps'] || headers['X-Ipag-Timestamps'];
        if (!event || !timestamp) {
            throw new HttpException('Missing X-Ipag-Event or X-Ipag-Timestamps header', HttpStatus.BAD_REQUEST);
        }

        // 3. Cálculo do HMAC SHA-256 usando a chave privada (this.apiKey)
        //    É importante que rawBody esteja no mesmo formato (compacto, UTF-8) utilizado para gerar a assinatura.
        const hmac = crypto.createHmac('sha256', this.apiKey);
        hmac.update(rawBody, 'utf8');
        const computedSignature = hmac.digest('hex');

        // 4. Comparação da assinatura recebida com a assinatura calculada, utilizando comparação segura (constant time)
        const signatureBuffer = Buffer.from(signature, 'utf8');
        const computedBuffer = Buffer.from(computedSignature, 'utf8');
        if (
            signatureBuffer.length !== computedBuffer.length ||
            !crypto.timingSafeEqual(signatureBuffer, computedBuffer)
        ) {
            throw new HttpException('Invalid callback signature', HttpStatus.BAD_REQUEST);
        }
    }

    /**
 * Returns a user-friendly error message based on the Gateway and Acquirer error codes.
 * Only errors that are likely caused by incorrect user input or insufficient funds are translated.
 *
 * @param gatewayCode - The error code returned in the "gateway" field.
 * @param acquirerCode - (Optional) The error code returned in the "acquirer" field.
 * @returns A user-friendly message string.
 */
    getUserFriendlyPaymentError(errorType: string, rawError: string): string {
        const gatewayErrorMessages: Record<string, string> = {
            'P5': 'Contate a central do seu cartão para resolver o problema.',
            'P6': 'Cartão expirado ou dados de vencimento incorretos. Verifique e tente novamente.',
            'P7': 'Método de pagamento temporariamente desativado. Tente novamente mais tarde.',
            'P2': 'Operação abortada. Tente novamente mais tarde.',
            'P3': 'Operação recusada por limitações do processador. Verifique os dados e tente novamente.',
            'P4': 'Operação recusada pelo processador. Verifique os dados informados.',
            'P9': 'Pagamento iniciado, mas não concluído. Tente novamente.',
        };

        const acquirerErrorMessages: Record<string, string> = {
            '07': 'Transação não permitida. Use um cartão de crédito.',
            '14': 'Número do cartão inválido. Verifique e tente novamente.',
            '15': 'Dados do titular inválidos. Verifique e tente novamente.',
            '19': 'Erro na transação. Por favor, tente novamente.',
            '38': 'Tentativas excedidas. Tente outro cartão.',
            '51': 'Saldo insuficiente. Verifique seu limite e tente novamente.',
            '54': 'Cartão expirado. Verifique os dados e tente novamente.',
            '55': 'Senha inválida. Verifique e tente novamente.',
            '61': 'Valor máximo excedido. Contate a central do seu cartão.',
            '75': 'Tentativas de senha excedidas. Contate a central do seu cartão.',
            '78': 'Cartão novo ou bloqueado. Contate a central do seu cartão.',
        };

        // Usa regex para extrair o código (exemplo: "Código: 07" → "07")
        const codeMatch = rawError.match(/Código:\s*(\w+)/);
        const errorCode = codeMatch ? codeMatch[1] : rawError.trim();

        if (errorType === 'Gateway') {
            if (gatewayErrorMessages[errorCode]) {
                return gatewayErrorMessages[errorCode];
            }
            return 'Houve um problema com o pagamento. Por favor, tente novamente.';
        }

        if (errorType === 'acquirer') {
            if (acquirerErrorMessages[errorCode]) {
                return acquirerErrorMessages[errorCode];
            }
            return 'Houve um problema com o pagamento. Por favor, tente novamente.';
        }

        return 'Houve um problema com o seu pagamento. Por favor, tente novamente.';
    }

    private async capturePayment(ipagTransactionId: string): Promise<IPagTransactionResponse | IPagErrorResponse> {
        const endpoint = `service/capture?id=${ipagTransactionId}`;
        const response = await this.makeRequest(endpoint, 'POST');

        console.log("[capturePayment] response", response);

        return response;
    }

    async simulateTransactionCompletion(transactionId: string): Promise<SimpleResponseDto<TransactionDTO>> {

        if (process.env.ENVIRONMENT === 'production') {
            throw new HttpException("This feature is only available in development or homologation mode", HttpStatus.BAD_REQUEST);
        }

        const transaction = await this.transactionService.getTransaction(transactionId);
        if (transaction.data.status !== PaymentStatus.Pending) {
            throw new HttpException("Transaction not pending", HttpStatus.BAD_REQUEST);
        }

        await this.transactionService.updateTransaction(transactionId, {
            status: PaymentStatus.Accepted,
            amountPaid: transaction.data.expectedAmount,
            confirmedAt: new Date(),
        });

        this.logger.log(`[simulateTransactionCompletion] Transaction ${transactionId} completed`);

        const conversation = await this.conversationService.getConversation(transaction.data.conversationId);

        this.logger.log(`[simulateTransactionCompletion] Conversation ${conversation.data._id}`);
        const paymentProcessorDTO: PaymentProcessorDTO = {
            transactionId: transaction.data._id.toString(),
            from: conversation.data.userId,
            state: conversation.data,
        };

        this.logger.log(`[simulateTransactionCompletion] Payment processor DTO ${JSON.stringify(paymentProcessorDTO)}`);

        await this.messageService.processPayment(paymentProcessorDTO);

        return { msg: "Transaction completed", data: transaction.data };
    }

    // Helper to generate random strings for mock data
    private generateRandomString(length: number): string {
        const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        return result;
    }

}
