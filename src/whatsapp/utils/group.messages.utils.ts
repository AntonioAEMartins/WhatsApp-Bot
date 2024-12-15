export enum GroupMessageKeys {
    AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
    AUTHENTICATION_SUCCESS = 'AUTHENTICATION_SUCCESS',
    PREBILL_ERROR = 'PREBILL_ERROR',
    FINISH_PAYMENT_ERROR = 'FINISH_PAYMENT_ERROR',
}

export const GroupMessages = {
    [GroupMessageKeys.AUTHENTICATION_ERROR]: () => 
        `❌ Coti Pagamentos - Erro ao conectar com o PDV \n\n Por favor *gere* uma nova *credencial* para a automação.`,
    
    [GroupMessageKeys.AUTHENTICATION_SUCCESS]: () => 
        `✅ Coti Pagamentos - Autenticação realizada com sucesso!`,
    
    [GroupMessageKeys.PREBILL_ERROR]: (orderNumber) => 
        `❌ Coti Pagamentos - Erro ao gerar pré-fatura da comanda ${orderNumber} \n\n Por favor *gere* uma nova *credencial* para a automação.`,
    
    [GroupMessageKeys.FINISH_PAYMENT_ERROR]: (orderNumber: string) => 
        `❌ Coti Pagamentos - Erro ao finalizar o pagamento da comanda ${orderNumber} \n\n Por favor *gere* uma nova *credencial* para a automação.`,
};