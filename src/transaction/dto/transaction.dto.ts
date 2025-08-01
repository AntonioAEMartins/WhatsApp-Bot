import { Type } from "class-transformer";
import { IsArray, IsDate, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, ValidateNested } from "class-validator";
import { ObjectId } from "mongodb";
import { PaymentDescription, PaymentStatus } from "src/conversation/dto/conversation.enums";
import { ConversationDto } from "src/conversation/dto/conversation.dto";
export class PaymentProofDTO {
    @IsString()
    nome_pagador: string;

    @IsString()
    cpf_cnpj_pagador: string;

    @IsString()
    instiuicao_bancaria: string;

    @IsNumber()
    valor: number;

    @IsString()
    data_pagamento: string;

    @IsString()
    nome_beneficiario: string;

    @IsString()
    cpf_cnpj_beneficiario: string;

    @IsString()
    instiuicao_bancaria_beneficiario: string;

    @IsString()
    id_transacao: string;
}

export enum PaymentMethod {
    PIX = 'pix',
    CREDIT_CARD = 'credit_card'
}

export class PixInfoDTO {
    @IsString()
    name: string;

    @IsString()
    document: string;
}

export class ErrorDescriptionDTO {
    @IsString()
    errorCode: string;

    @IsString()
    userFriendlyMessage: string;

    @IsString()
    rawError: string;
}

export class BaseTransactionDTO {
    // Referência ao pedido desta transação
    @IsString()
    @IsNotEmpty()
    orderId: string;

    @IsString()
    @IsNotEmpty()
    tableId: string;

    // Referência à conversa na qual esta transação foi iniciada
    @IsString()
    @IsOptional()
    conversationId?: string;

    @IsEnum(PaymentMethod)
    @IsOptional()
    paymentMethod: PaymentMethod;

    @IsString()
    @IsOptional()
    userId?: string;

    @IsNumber()
    amountPaid: number;

    @IsNumber()
    expectedAmount: number;

    @IsEnum(PaymentStatus)
    status: PaymentStatus;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => PaymentProofDTO)
    @IsOptional()
    paymentProofs?: PaymentProofDTO[];

    @IsNumber()
    initiatedAt: Date;

    @IsOptional()
    confirmedAt?: Date;

    @IsOptional()
    expiresAt?: Date;

    @IsOptional()
    createdAt?: Date;

    @IsOptional()
    updatedAt?: Date;

    @IsOptional()
    @IsEnum(PaymentDescription)
    description?: PaymentDescription;

    @IsOptional()
    @IsString()
    ipagTransactionId?: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => PixInfoDTO)
    pixInfo?: PixInfoDTO;

    @IsOptional()
    @IsString()
    cardId?: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => ErrorDescriptionDTO)
    errorDescription?: ErrorDescriptionDTO;

    @IsOptional()
    @IsDate()
    reminderSentAt?: Date;
}

export class CreateTransactionDTO extends BaseTransactionDTO {
}

export class TransactionDTO extends BaseTransactionDTO {
    @IsString()
    @IsNotEmpty()
    _id: ObjectId;
}

export class ReceivedPaymentDTO {
    // Referência ao pedido desta transação
    @IsString()
    @IsNotEmpty()
    orderId: string;

    // Referência à conversa na qual esta transação foi iniciada
    @IsString()
    @IsOptional()
    conversationId?: string;

    @IsString()
    @IsOptional()
    userId?: string;

    @IsNumber()
    amountPaid: number;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => PaymentProofDTO)
    @IsOptional()
    paymentProofs?: PaymentProofDTO[];
}

export class PaymentProcessorDTO {
    transactionId: string;
    from: string;
    state: ConversationDto;
}