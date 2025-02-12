import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { CreatePaymentDto, PaymentMethodCard, PaymentMethodPix, PaymentType, UserPaymentCreditInfoDto, UserPaymentPixInfoDto } from './dto/ipag-pagamentos.dto';
import { IPagTransactionResponse } from './types/ipag-response.types';
import { CreateEstablishmentDto, CreateSellerDto } from './dto/ipag-marketplace.dto';
import { CreateCheckoutDto } from './dto/ipag-checkout.dto';
import { Db } from 'mongodb';
import { ClientProvider } from 'src/db/db.module';
import { TransactionService } from 'src/transaction/transaction.service';
import { PaymentStatus } from 'src/conversation/dto/conversation.enums';
@Injectable()
export class IPagService {
    private readonly baseURL: string;
    private readonly apiId: string;
    private readonly apiKey: string;

    constructor(
        private readonly transactionService: TransactionService,
    ) {
        // You can set these values using environment variables for security

        const ipagBaseUrl = process.env.ENVIRONMENT === 'development' ? process.env.IPAG_BASE_DEV_URL : process.env.ENVIRONMENT === 'homologation' ? process.env.IPAG_BASE_DEV_URL : process.env.IPAG_BASE_PROD_URL;
        this.baseURL = ipagBaseUrl || 'https://api.ipag.com.br';
        this.apiId = process.env.IPAG_API_ID
        this.apiKey = process.env.IPAG_API_KEY
    }

    // Function to create the Authorization header for HTTP Basic Auth
    private getAuthHeader(): string {
        const credentials = `${this.apiId}:${this.apiKey}`;
        return `Basic ${Buffer.from(credentials).toString('base64')}`;
    }

    // Example function to make authenticated requests
    async makeRequest(endpoint: string, method: 'GET' | 'POST', data?: any): Promise<any> {
        try {
            const headers = {
                Authorization: this.getAuthHeader(),
                'Content-Type': 'application/json',
                // 'x-api-version': '2',
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
        const transaction = await this.transactionService.getTransaction(userPaymentInfo.transactionId);

        if (!transaction) {
            throw new HttpException('Transaction not found', HttpStatus.NOT_FOUND);
        }

        if (transaction.data.status !== PaymentStatus.Pending) {
            throw new HttpException('Transaction not pending', HttpStatus.BAD_REQUEST);
        }

        const paymentData: CreatePaymentDto = {
            amount: transaction.data.expectedAmount,
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
            split_rules: [{
                seller_id: "bd0181690d928c05350f75ce49aecb2a",
                percentage: 100,
            }]
        }

        const endpoint = 'service/payment';
        try {
            const response = await this.makeRequest(endpoint, 'POST', paymentData) as IPagTransactionResponse;

            console.log('[createPIXPayment] response:', response);

            await this.transactionService.updateTransaction(userPaymentInfo.transactionId, {
                ipagTransactionId: response.uuid,
            });

            return response as IPagTransactionResponse;
        } catch (error) {
            console.error('Error creating payment:', error);
            if (error instanceof HttpException) {
                throw error;
            }
            throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
        }
    }

    /**
   * Cria um pagamento enviando os dados para o endpoint correspondente.
   * Após obter a resposta, verifica se há algum erro (ex.: cartão expirado,
   * dados incorretos etc.) e, em caso afirmativo, lança uma exceção.
   */
    async createCreditCardPayment(
        userPaymentInfo: UserPaymentCreditInfoDto,
        transaction_id: string,
    ): Promise<IPagTransactionResponse> {

        const transaction = await this.transactionService.getTransaction(transaction_id);

        if (!transaction) {
            throw new HttpException('Transaction not found', HttpStatus.NOT_FOUND);
        }

        if (transaction.data.status !== PaymentStatus.Pending) {
            throw new HttpException('Transaction not pending', HttpStatus.BAD_REQUEST);
        }

        const paymentData: CreatePaymentDto = {
            amount: transaction.data.expectedAmount,
            payment: {
                type: PaymentType.card,
                method: this.getCardMethod(userPaymentInfo.cardInfo.number),
                installments: 1,
                softdescriptor: 'AstraPay',
                card: {
                    holder: userPaymentInfo.cardInfo.holder,
                    number: userPaymentInfo.cardInfo.number,
                    expiry_month: userPaymentInfo.cardInfo.expiry_month,
                    expiry_year: userPaymentInfo.cardInfo.expiry_year,
                    cvv: userPaymentInfo.cardInfo.cvv,
                    tokenize: userPaymentInfo.saveCard,
                },
            },
            order_id: transaction_id,
            customer: {
                name: userPaymentInfo.customerInfo.name,
                cpf_cnpj: userPaymentInfo.customerInfo.cpf_cnpj,
            },
            split_rules: [{
                seller_id: "bd0181690d928c05350f75ce49aecb2a",
                percentage: 100,
            }]
        }

        const endpoint = 'service/payment'; // Ajuste este endpoint conforme a documentação do iPag
        try {
            const response = await this.makeRequest(endpoint, 'POST', paymentData);

            // Trata a resposta: se o código do gateway não for de sucesso, lança erro.
            const processedResponse = this.processTransactionResponse(response);
            if (processedResponse.type !== "sucess") {
                throw new HttpException(processedResponse.erros.join(' '), HttpStatus.BAD_REQUEST);
            }
            return response as IPagTransactionResponse;
        } catch (error) {
            console.error('Error creating payment:', error);
            // Se já for uma HttpException, repassa-a; caso contrário, cria uma nova.
            if (error instanceof HttpException) {
                throw error;
            }
            throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
        }
    }

    /**
   * Lista as taxas da conta.
   * Se a resposta apresentar um objeto de erro, lança uma exceção com a mensagem adequada.
   */
    async listAccountFees(): Promise<any> {
        const endpoint = 'service/v2/account/my-fees';
        try {
            const response = await this.makeRequest(endpoint, 'GET');
            // Caso a resposta contenha um campo 'error', trate-o.
            if (response && response.error) {
                const errorMsg = response.error.message || 'Erro ao listar taxas';
                throw new HttpException(errorMsg, HttpStatus.BAD_REQUEST);
            }
            // Se a resposta tiver a estrutura esperada (por exemplo, um campo 'data'), retorne-o.
            return response.data;
        } catch (error) {
            console.error('Error listing account fees:', error);
            if (error instanceof HttpException) {
                throw error;
            }
            throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
        }
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
        // Verifica se os dados possuem a estrutura esperada
        if (!response || !response.attributes) {
            return { type: "acquirer", erros: ["Dados da transação inválidos."] };
        }
        const { gateway, acquirer, status } = response.attributes;

        // 1. Validação do Gateway
        if (!gateway || !gateway.code) {
            return { type: "Gateway", erros: ["Código de gateway ausente."] };
        }
        if (!['P0', 'F0', 'F1'].includes(gateway.code)) {
            return { type: "Gateway", erros: [gateway.message || "Erro no gateway."] };
        }

        // 2. Validação do Acquirer
        if (!acquirer || !acquirer.code) {
            return { type: "acquirer", erros: ["Código do adquirente ausente."] };
        }
        if (acquirer.code !== "00") {
            const errors: string[] = [];
            errors.push(acquirer.message || "Erro no adquirente.");
            // Se houver dados de status, também os valida
            if (!status || typeof status.code === "undefined") {
                errors.push("Status da transação ausente.");
            } else if (status.code !== 8) {
                errors.push(status.message || "Transação não capturada.");
            }
            return { type: "acquirer", erros: errors };
        }

        // 3. Validação do Status da transação
        if (!status || typeof status.code === "undefined") {
            return { type: "acquirer", erros: ["Status da transação ausente."] };
        }
        if (status.code !== 8) {
            return { type: "acquirer", erros: [status.message || "Transação não capturada."] };
        }

        // Se todas as validações passaram, a transação é considerada com sucesso.
        return { type: "sucess", erros: [] };
    }

    /**
     * Processa os dados do callback recebidos do iPag e retorna um JSON com:
     * - type: "Gateway" (erro no gateway), "acquirer" (erro do adquirente ou status) ou "sucess"
     * - erros: uma lista de mensagens de erro (caso existam)
     *
     * @param callbackData Dados recebidos no callback
     * @returns JSON com { type, erros }
     */
    async processCallback(callbackData: any): Promise<any> {
        try {
            // console.log('[processCallback] Dados do callback:', callbackData);
            const result = this.processTransactionResponse(callbackData);
            console.log('[processCallback] Resultado do processamento:', result);
            return result;
        } catch (error) {
            console.error('[processCallback] Erro ao processar callback:', error);
            if (error instanceof HttpException) {
                throw error;
            }
            throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
        }
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

    // async createCreditCardPayment(createCreditCardPayment: UserPaymentInfoDto): Promise<any> {

    //     const paymentMethod = this.getCardMethod(createCreditCardPayment.cardInfo.number);

    //     const paymentData: CreatePaymentDto = {
    //         amount: createCreditCardPayment.amount,
    //         payment: {
    //             type: PaymentType.card,
    //             method: paymentMethod,
    //             installments: 1,
    //             softdescriptor: 'AstraPay',
    //             card: {
    //                 holder: createCreditCardPayment.cardInfo.holder,
    //                 number: createCreditCardPayment.cardInfo.number,
    //                 expiry_month: createCreditCardPayment.cardInfo.expiry_month,
    //                 expiry_year: createCreditCardPayment.cardInfo.expiry_year,
    //                 cvv: createCreditCardPayment.cardInfo.cvv,
    //                 tokenize: createCreditCardPayment.saveCard,
    //             }
    //         }
    //     }

    //     const endpoint = 'service/payment';
    //     try {
    //         const response = await this.makeRequest(endpoint, 'POST', createCreditCardPayment);
    //         return response;
    //     }
    // }

    async createCheckout(createCheckout: CreateCheckoutDto): Promise<any> {
        const endpoint = '/service/resources/checkout';
        console.log('[createCheckout] createCheckout:', createCheckout);
        try {
            const response = await this.makeRequest(endpoint, 'POST', createCheckout);
            return response;
        } catch (error) {
            console.error('Error creating checkout:', error);
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

        const firstDigit = cardNumber.charAt(0);
        const firstTwoDigits = cardNumber.substring(0, 2);
        const firstFourDigits = cardNumber.substring(0, 4);

        if (/^4/.test(cardNumber)) {
            return PaymentMethodCard.visa;
        } else if (/^5[1-5]/.test(cardNumber)) {
            return PaymentMethodCard.mastercard;
        } else if (/^3[47]/.test(cardNumber)) {
            return PaymentMethodCard.amex;
        } else if (/^6(?:011|5)/.test(cardNumber)) {
            return PaymentMethodCard.discover;
        } else if (/^3(?:0[0-5]|[68])/.test(cardNumber)) {
            return PaymentMethodCard.diners;
        } else if (/^35/.test(cardNumber)) {
            return PaymentMethodCard.jcb;
        } else if (/^636368|^438935|^504175|^451416|^636297/.test(cardNumber)) {
            return PaymentMethodCard.elo;
        } else if (/^606282|^3841(?:[0|4|6]{1})0/.test(cardNumber)) {
            return PaymentMethodCard.hipercard;
        } else if (/^637095|^637568|^637599|^637609|^637612/.test(cardNumber)) {
            return PaymentMethodCard.hiper;
        } else if (/^50/.test(cardNumber)) {
            return PaymentMethodCard.aura;
        } else if (/^4026|^417500|^4508|^4844|^4913|^4917/.test(cardNumber)) {
            return PaymentMethodCard.visaelectron;
        } else if (/^5018|^5020|^5038|^5893|^6304|^6759|^6761|^6762|^6763/.test(cardNumber)) {
            return PaymentMethodCard.maestro;
        }

        return null; // Return null if no match is found
    }



}
