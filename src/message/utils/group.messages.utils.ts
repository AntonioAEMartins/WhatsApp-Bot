export enum GroupMessageKeys {
    AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
    AUTHENTICATION_SUCCESS = 'AUTHENTICATION_SUCCESS',
    PREBILL_ERROR = 'PREBILL_ERROR',
    FINISH_PAYMENT_ERROR = 'FINISH_PAYMENT_ERROR',
    ORDER_PROCESSING_ERROR = 'ORDER_PROCESSING_ERROR',
}

export const GroupMessages = {
    [GroupMessageKeys.AUTHENTICATION_ERROR]: () =>
        `❌ *Astra Pagamentos* - *Erro de Autenticação*\n\nNão foi possível conectar ao PDV. Por favor, gere uma nova credencial para continuar a automação.`,

    [GroupMessageKeys.AUTHENTICATION_SUCCESS]: () =>
        `✅ *Astra Pagamentos* - *Autenticação Bem-sucedida!*`,

    [GroupMessageKeys.PREBILL_ERROR]: (orderNumber: string) =>
        `❌ *Astra Pagamentos* - *Erro na Pré-fatura*\n\nHouve um problema ao gerar a pré-fatura da comanda ${orderNumber}. Por favor, verifique os detalhes ou entre em contato com o suporte.`,

    [GroupMessageKeys.FINISH_PAYMENT_ERROR]: (orderNumber: string) =>
        `❌ *Astra Pagamentos* - *Erro no Pagamento*\n\nNão foi possível finalizar o pagamento da comanda ${orderNumber}. Por favor, tente novamente ou entre em contato com o suporte.`,

    [GroupMessageKeys.ORDER_PROCESSING_ERROR]: (orderNumber: string) =>
        `❌ *Astra Pagamentos* - *Erro no Processamento*\n\nOcorreu um erro ao processar a comanda ${orderNumber}. Por favor, realize o pagamento manualmente.`,
};
