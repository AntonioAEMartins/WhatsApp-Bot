// ipag.types.ts

/**
 * Successful Transaction Response
 */
export interface IPagTransactionResponse {
    id: number;
    uuid: string;
    resource: string;
    attributes: TransactionAttributes;
}

/**
 * Main Attributes for a Transaction
 */
export interface TransactionAttributes {
    seller_id: string;
    order_id: string;
    amount: number;
    installments: number;
    tid: string;
    authorization_id: string;
    status: TransactionStatus;
    method: string;
    captured_amount: number;
    captured_at: string;
    url_authentication: string;
    callback_url: string;
    created_at: string;
    updated_at: string;
    acquirer: AcquirerResponse;
    gateway: GatewayResponse;
    card?: CardResponse | null;
    boleto?: BoletoResponse | null;
    pix?: PixResponse | null;
    customer: CustomerResponse;
    subscription?: SubscriptionResponse | null;
    products: ProductResponse[];
    antifraud?: AntifraudResponse | null;
    split_rules?: SplitRuleResponse[];
    receivables?: ReceivableResponse[];
    history: HistoryItemResponse[];
}

/**
 * Transaction Status Information
 */
export interface TransactionStatus {
    code: number;
    message: string;
}

/**
 * Acquirer (Adquirente) Information
 */
export interface AcquirerResponse {
    name: string;
    message: string;
    code: string;
    merchant_id: string;
}

/**
 * Gateway Information
 */
export interface GatewayResponse {
    code: string;
    message: string;
}

/**
 * Card Information (Credit/Debit)
 */
export interface CardResponse {
    holder: string;
    number: string;
    expiry_month: string;
    expiry_year: string;
    brand: string;
    token?: string;
}

/**
 * Boleto (Bank Slip) Information – for boleto payments
 */
export interface BoletoResponse {
    due_date: string;
    digitable_line: string;
    link: string;
}

/**
 * Pix Payment Information – for Pix transactions
 */
export interface PixResponse {
    link: string;
    qrcode: string;
}

/**
 * Customer (Payer) Information
 */
export interface CustomerResponse {
    name: string;
    cpf_cnpj: string;
    email: string;
    phone: string;
    billing_address: AddressResponse;
    shipping_address: AddressResponse;
}

/**
 * Address Details
 */
export interface AddressResponse {
    street: string;
    number: string;
    district: string;
    complement: string;
    city: string;
    state: string;
    zipcode: string;
    country?: string; // ISO 3166-1 alpha-2; default “BR” if not provided
}

/**
 * Subscription Information (for recurring payments)
 */
export interface SubscriptionResponse {
    frequency: number;
    interval: 'day' | 'week' | 'month';
    start_date: string;
    amount?: number;
    installments?: number;
    cycles?: number;
    trial?: SubscriptionTrialResponse;
}

/**
 * Subscription Trial Details (if any)
 */
export interface SubscriptionTrialResponse {
    amount?: number;
    cycles?: number;
    frequency?: number;
}

/**
 * Product Details for the Transaction
 */
export interface ProductResponse {
    name: string;
    description?: string;
    unit_price: number;
    quantity: number;
    sku: string;
}

/**
 * Antifraud Analysis Details
 */
export interface AntifraudResponse {
    score: number;
    status: string;
    message: string;
}

/**
 * Split Rules for Payment (if using split payments)
 */
export interface SplitRuleResponse {
    id: number;
    resource: string;
    attributes: SplitRuleAttributes;
}

/**
 * Attributes for a Split Rule
 */
export interface SplitRuleAttributes {
    receiver_id: string;
    percentage?: number;
    amount?: number;
    liable: boolean;
    charge_processing_fee: boolean;
    created_at: string;
    updated_at: string;
}

/**
 * Receivables Information (for sub-acquirers)
 */
export interface ReceivableResponse {
    id: number;
    resource: string;
    attributes: ReceivableAttributes;
}

/**
 * Attributes for a Receivable
 */
export interface ReceivableAttributes {
    receiver_id: string;
    receiver_uuid: string;
    transaction: string;
    status: 'pending' | 'paid' | 'canceled' | 'refunded' | 'blocked';
    amount: number;
    gross_amount: number;
    installment: number;
    description: string;
    paid_at?: string;
    canceled_at?: string;
    expected_on?: string;
    created_at: string;
    updated_at: string;
}

/**
 * History Item – events recorded for the Transaction
 */
export interface HistoryItemResponse {
    amount: number;
    type: string;
    status: string;
    response_code: string;
    response_message: string;
    authorization_code: string;
    authorization_id: string;
    authorization_nsu: string;
    created_at: string;
}

/**
 * Error Response from the iPag API
 */
export interface IPagErrorResponse {
    code: string;
    message: { [field: string]: string[] };
    resource: string;
}

/* --------------------------------------------------------------------------
   Enumerators for iPag Gateway and Acquirer Codes
   -------------------------------------------------------------------------- */

/**
 * Gateway Codes – these codes may evolve over time.
 * (Comments show the meaning as per the documentation.)
 */
export enum GatewayCode {
    P0 = 'P0', // A operação foi concluida com sucesso (Sucesso)
    P1 = 'P1', // A operação não foi concluida devido à um erro (Erro)
    P2 = 'P2', // A operação foi ABORTADA (Erro)
    P3 = 'P3', // A operação foi RECUSADA pelo processador de pagamentos devido a um limitador (Erro)
    P4 = 'P4', // A operação foi RECUSADA pelo processador de pagamentos (Erro)
    P5 = 'P5', // A transação está em quarentena (Erro)
    P6 = 'P6', // O cartão informado expirou ou possui dados de vencimento incorretos (Erro)
    P7 = 'P7', // O cartão e/ou cliente informado estão/está na lista negra (Erro)
    P9 = 'P9', // O processo foi iniciado (Erro)
    F0 = 'F0', // A transação foi APROVADA automaticamente devido às regras de antifraude (Sucesso)
    F1 = 'F1', // A transação foi RECUSADA automaticamente devido às regras de antifraude (Sucesso)
    F2 = 'F2'  // A transação foi avaliada pelo antifraude, porém sua ação posterior falhou (captura/cancelamento) (Erro)
}

/**
 * Acquirer Codes – codes returned by the payment processor.
 * (Each code is mapped as a string for consistency.)
 */
export enum AcquirerCode {
    Approved = '00',                            // APROVADA E COMPLETADA COM SUCESSO
    ReferToCardIssuer = '01',                   // CONTATE A CENTRAL DO SEU CARTAO - NAO TENTE NOVAMENTE
    InvalidMerchant = '03',                     // TRANSACAO NAO PERMITIDA - NAO TENTE NOVAMENTE
    PickUp = '04',                              // CONTATE A CENTRAL DO SEU CARTAO - NAO TENTE NOVAMENTE
    DoNotHonor = '05',                          // CONTATE A CENTRAL DO SEU CARTAO
    Error = '06',                               // LOJISTA, CONTATE O ADQUIRENTE
    PickUpSpecial = '07',                       // TRANSAÇÃO NÃO PERMITIDA PARA O CARTÃO - NÃO TENTE NOVAMENTE
    HonourWithIdentification = '08',            // NAO AUTORIZADA - TENTE NOVAMENTE USANDO AUTENTICACAO
    InvalidTransaction = '12',                  // TRANSACAO INVALIDA - NAO TENTE NOVAMENTE
    InvalidAmount = '13',                       // VALOR DA TRANSACAO NAO PERMITIDO - NAO TENTE NOVAMENTE
    InvalidCardNumber = '14',                   // VERIFIQUE OS DADOS DO CARTAO
    NoSuchIssuer = '15',                        // DADOS DO CARTAO INVALIDO - NAO TENTE NOVAMENTE
    ReEnterTransaction = '19',                  // REFAZER A TRANSACAO
    UnacceptableTransactionFee = '23',          // PARCELAMENTO INVALIDO - NAO TENTE NOVAMENTE
    FormatError = '30',                         // ERRO NO CARTÃO - NÃO TENTE NOVAMENTE
    AllowablePINTriesExceeded = '38',           // QTDADE DE TENTATIVAS EXCEDIDAS - NAO TENTE NOVAMENTE
    NoCreditAccount = '39',                     // UTILIZE FUNCAO DEBITO
    RequestedFunctionNotSupported = '40',       // SAQUE NAO DISPONIVEL - NAO TENTE NOVAMENTE
    LostCard = '41',                            // TRANSAÇÃO NÃO PERMITIDA - NÃO TENTE NOVAMENTE
    NoUniversalAccount = '42',                  // UTILIZE FUNCAO CREDITO
    StolenCard = '43',                          // TRANSAÇÃO NÃO PERMITIDA - NÃO TENTE NOVAMENTE
    NotSufficientFunds = '51',                  // NAO AUTORIZADA - LIMITE INSUFICIENTE
    ExpiredCard = '54',                         // VERIFIQUE OS DADOS DO CARTAO
    IncorrectPIN = '55',                        // SENHA INVALIDA
    TransactionNotPermittedToCardholder = '57', // TRANSACAO NAO PERMITIDA PARA O CARTAO - NAO TENTE NOVAMENTE
    TransactionNotPermittedToTerminal = '58',    // TRANSACAO NAO PERMITIDA - NAO TENTE NOVAMENTE
    SuspectedFraud = '59',                        // CONTATE A CENTRAL DO SEU CARTÃO
    ExceedsWithdrawalAmountLimit = '61',         // VALOR EXCEDIDO. CONTATE A CENTRAL DO SEU CARTAO
    RestrictedCard = '62',                       // CARTAO NAO PERMITE TRANSACAO INTERNACIONAL
    SecurityViolation = '63',                    // VERIFIQUE OS DADOS DO CARTAO
    OriginalAmountIncorrect = '64',              // VALOR DA TRANSAÇÃO NÃO PERMITIDO - NÃO TENTE NOVAMENTE
    ExceedsWithdrawalFrequencyLimit = '65',      // QTDADE DE SAQUES EXCEDIDA. CONTATE A CENTRAL DO SEU CARTAO
    ReservedForISO_PINError = '74',              // SENHA INVÁLIDA - NÃO TENTE NOVAMENTE
    AllowableNumberOfPINTriesExceeded = '75',      // EXCEDIDAS TENTATIVAS DE SENHA. CONTATE A CENTRAL DO SEU CARTAO
    ReservedForPrivateUse_InvalidTargetAccount = '76',  // CONTA DESTINO INVALIDA - NAO TENTE NOVAMENTE
    ReservedForPrivateUse_InvalidSourceAccount = '77',  // CONTA ORIGEM INVALIDA - NAO TENTE NOVAMENTE
    ReservedForPrivateUse_NewBlockedCard = '78',        // DESBLOQUEIE O CARTAO
    ReservedForPrivateUse_InvalidCard = '82',           // ERRO NO CARTAO - NAO TENTE NOVAMENTE
    IssuerOrSwitchInoperative = '91',          // FALHA DE COMUNICACAO - TENTE MAIS TARDE
    FinancialInstitutionNotFound = '92',       // CONTATE A CENTRAL DO SEU CARTAO - NÃO TENTE NOVAMENTE
    TransactionCannotBeCompleted_ViolationOfLaw = '93',  // TRANSAÇÃO NÃO PERMITIDA PARA O CARTÃO - NÃO TENTE NOVAMENTE
    DuplicateTransmission = '94',              // CONTATE A CENTRAL DO SEU CARTAO - NÃO TENTE NOVAMENTE
    SystemMalfunction = '96',                  // FALHA DE COMUNICACAO - TENTE MAIS TARDE
    ReservedForNationalUse_AmountMismatch = '99' // VALOR DIFERENTE DA PRE AUTORIZACAO - NAO TENTE NOVAMENTE
}
