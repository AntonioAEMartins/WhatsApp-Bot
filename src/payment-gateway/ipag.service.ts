import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { CreatePaymentDto, PaymentMethodCard, PaymentMethodPix, PaymentType, UserPaymentCreditInfoDto, UserPaymentPixInfoDto } from './dto/ipag-pagamentos.dto';
import { IPagErrorResponse, IPagTransactionResponse } from './types/ipag-response.types';
import { CreateEstablishmentDto, CreateSellerDto } from './dto/ipag-marketplace.dto';
import { TransactionService } from 'src/transaction/transaction.service';
import { PaymentStatus } from 'src/conversation/dto/conversation.enums';
import * as crypto from 'crypto';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { SimpleResponseDto } from 'src/request/request.dto';
import { ConversationService } from 'src/conversation/conversation.service';
import { PaymentProcessorDTO } from 'src/whatsapp/payment.processor';
import { PaymentMethod, TransactionDTO } from 'src/transaction/dto/transaction.dto';
import { CardService } from 'src/card/card.service';
@Injectable()
export class IPagService {
    private readonly baseURL: string;
    private readonly apiId: string;
    private readonly apiKey: string;
    private readonly ipagSplitSellerId: string;

    constructor(
        @InjectQueue('payment') private readonly paymentQueue: Queue,
        private readonly transactionService: TransactionService,
        private readonly conversationService: ConversationService,
        private readonly cardService: CardService
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
        // Valida a transação para PIX – se não estiver Pending e for Failed, cria nova transação e continua;
        // se estiver em outro status, lança exceção.
        const transaction = await this.validateTransaction(
            userPaymentInfo.transactionId,
            PaymentMethod.PIX,
            true,
        );

        const paymentData: CreatePaymentDto = {
            amount: transaction.expectedAmount,
            payment: {
                type: PaymentType.pix,
                method: PaymentMethodPix.pix,
                pix_expires_in: userPaymentInfo.pixExpiresIn,
                installments: 1,
                softdescriptor: 'AstraPay',
            },
            customer: {
                name: userPaymentInfo.customerInfo.name.substring(0, 80),
                cpf_cnpj: userPaymentInfo.customerInfo.cpf_cnpj,
            },
            split_rules: [
                {
                    seller_id: this.ipagSplitSellerId,
                    percentage: 100,
                },
            ],
        };

        const endpoint = 'service/payment';
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
            console.error('Error creating payment:', error);
            if (error instanceof HttpException) {
                throw error;
            }
            throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
        }
    }

    async createCreditCardPayment(
        userPaymentInfo: UserPaymentCreditInfoDto,
    ): Promise<SimpleResponseDto<{ msg: string }>> {
        // Valida a transação e garante que ela está no estado adequado.
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
            cardPayload = { token: userPaymentInfo.cardId };
            holderName = existingCardResponse.data.holderName;
            holderDocument = existingCardResponse.data.holderDocument;
        } else {
            cardBrand = this.getCardMethod(userPaymentInfo.cardInfo.number);
            cardPayload = {
                holder: userPaymentInfo.cardInfo.holder,
                number: userPaymentInfo.cardInfo.number,
                expiry_month: userPaymentInfo.cardInfo.expiry_month,
                expiry_year: userPaymentInfo.cardInfo.expiry_year,
                cvv: userPaymentInfo.cardInfo.cvv,
                tokenize: userPaymentInfo.saveCard,
            };
            holderName = userPaymentInfo.customerInfo.name;
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
                softdescriptor: 'AstraPay',
                card: cardPayload,
            },
            customer: {
                name: holderName,
                cpf_cnpj: holderDocument,
            },
            split_rules: [
                {
                    seller_id: this.ipagSplitSellerId,
                    percentage: 100,
                },
            ],
        };

        try {
            const response = await this.makeRequest('service/payment', 'POST', paymentData);

            if (!this.isTransactionResponse(response)) {
                throw new HttpException('Invalid transaction response', HttpStatus.BAD_REQUEST);
            }

            const processedResponse = this.processTransactionResponse(response);
            if (processedResponse.type !== 'success') {
                throw new HttpException(processedResponse.erros.join(' '), HttpStatus.BAD_REQUEST);
            }

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
                });
            }

            const finalCardId = userPaymentInfo.cardId || createdCard.data._id;
            await this.transactionService.updateTransaction(userPaymentInfo.transactionId, {
                ipagTransactionId: response.uuid,
                cardId: finalCardId,
            });

            return {
                msg: 'Payment created',
                data: { msg: 'Payment created' },
            };
        } catch (error) {
            console.error('Error creating payment:', error);
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
            throw new HttpException('Transaction not found', HttpStatus.NOT_FOUND);
        }

        if (transaction.data.status !== PaymentStatus.Pending) {
            throw new HttpException('Transaction not pending', HttpStatus.BAD_REQUEST);
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
   * - Acquirer: O código deve ser "00". Se não for, retorna erro do tipo "acquirer".
   * - Status: Espera-se que o código seja 8 (por exemplo, "CAPTURED"). Caso contrário, também será classificado como erro do tipo "acquirer".
   *
   * @param response Dados da transação (callback)
   * @returns JSON com { type: string, erros: string[] }
   */

    private processTransactionResponse(response: any): { type: string; erros: string[] } {

        // Verifica se a resposta possui a estrutura esperada
        if (!response || !response.attributes) {
            return { type: "acquirer", erros: ["Dados da transação inválidos."] };
        }
        const { gateway, acquirer, status } = response.attributes;

        // 1. Validação do Gateway (sempre obrigatório)
        if (!gateway || !gateway.code) {
            return { type: "Gateway", erros: ["Código de gateway ausente."] };
        }
        if (!['P0', 'F0', 'F1'].includes(gateway.code)) {
            return { type: "Gateway", erros: [gateway.message || "Erro no gateway."] };
        }

        // 2. Verifica se o status da transação está presente
        if (!status || typeof status.code === "undefined") {
            return { type: "acquirer", erros: ["Status da transação ausente."] };
        }

        // 3. Tratamento dos diferentes códigos de status:
        // - Código 2: A transação está aguardando pagamento
        if (status.code === 2) {
            return { type: "waiting", erros: [] };
        }

        // - Código 1: Transação criada (ainda não iniciou o processo de pagamento)
        if (status.code === 1) {
            return { type: "created", erros: [] };
        }

        // - Código 8: Pagamento capturado com sucesso
        if (status.code === 8) {
            // Para o sucesso, é exigido que o adquirente possua um código válido
            if (!acquirer || !acquirer.code) {
                return { type: "acquirer", erros: ["Código do adquirente ausente."] };
            }
            if (acquirer.code !== "00") {
                return { type: "acquirer", erros: [acquirer.message || "Erro no adquirente."] };
            }
            return { type: "success", erros: [] };
        }

        // Para qualquer outro código de status, retorna o erro informado (ou uma mensagem padrão)
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
            // Valida IP, headers obrigatórios e assinatura
            this.validateCallback(ipAddress, headers, rawBody);

            // Processa os dados do callback utilizando a lógica já existente
            const result = this.processTransactionResponse(callbackData);

            console.log("[processCallback] Result", result);

            if (result.type === "success") {
                console.log("[processCallback] Callback data is a transaction response");
                if (this.isTransactionResponse(callbackData)) { // usa a type guard
                    const transaction = await this.transactionService.getTransactionByipagTransactionId(callbackData.uuid);

                    const conversation = await this.conversationService.getConversation(transaction.data.conversationId);

                    if (transaction.data.status !== PaymentStatus.Pending) {
                        console.warn('[processCallback] Transaction not pending, ignoring callback');
                        return { type: "error", errors: ["Transaction not pending."] };
                    }

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

                    this.paymentQueue.add(paymentProcessorDTO);
                    return { type: "success", errors: [] };
                } else {
                    // Se não for uma transação de sucesso, retorne um erro genérico
                    console.error("[processCallback] Invalid transaction data in callback.");
                    return { type: "error", errors: ["Callback does not contain valid transaction data."] };
                }
            } else {
                console.error('[processCallback] Transaction error:', result.erros);
                return { type: "error", errors: result.erros };
            }
        } catch (error) {
            console.error('Error handling callback:', error);
            // Retorna um erro genérico para garantir o retorno de 200
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

        // Remover espaços e traços do número do cartão
        cardNumber = cardNumber.replace(/[\s-]/g, '');

        // Expressões regulares para identificar as bandeiras dos cartões
        const cardPatterns = {
            elo: /^(?:4011\d{12}|431274\d{10}|438935\d{10}|451416\d{10}|457393\d{10}|45763[1-2]\d{10}|504175\d{10}|506699\d{10}|5067(?:[0-6]\d|7[0-8])\d{9}|509\d{3}\d{10}|627780\d{10}|636297\d{10}|636368\d{10}|636369\d{10}|6500(?:3[1-3]|3[5-9]|4\d|5[0-1])\d{10}|650(?:4(?:0[5-9]|\d{2})|5(?:[0-2]\d|3[0-8]|4[1-9]|[5-8]\d|9[0-8]))\d{10}|6507(?:0\d|1[0-8]|2[0-7])\d{10}|6509(?:0[1-9]|1\d|20)\d{10}|6516(?:5[2-9]|[6-7]\d)\d{10}|6550(?:[0-1]\d|2[1-9]|[3-4]\d|5[0-8])\d{10})$/,
            visa: /^4[0-9]{12}(?:[0-9]{3})?$/,
            mastercard: /^(5[1-5][0-9]{14}|2(?:2[2-9][0-9]{2}|[3-6][0-9]{3}|7[01][0-9]{2}|720)[0-9]{12})$/,
            amex: /^3[47][0-9]{13}$/,
            discover: /^6(?:011|5[0-9]{2})[0-9]{12}$/,
            diners: /^3(?:0[0-5]|[68][0-9])[0-9]{11}$/,
            jcb: /^(?:2131|1800|35\d{3})\d{11}$/,
            hipercard: /^(606282\d{10}(\d{3})?|3841\d{15}|637\d{13})$/,
            aura: /^50[0-9]{14,17}$/,
            maestro: /^(5018|5020|5038|5893|6304|6759|676[1-3])\d{8,15}$/,
        };

        // Iterar sobre os padrões para encontrar correspondência
        for (const [brand, pattern] of Object.entries(cardPatterns)) {
            if (pattern.test(cardNumber)) {
                return brand as PaymentMethodCard;
            }
        }

        return null; // Retorna null se nenhuma correspondência for encontrada
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

}
