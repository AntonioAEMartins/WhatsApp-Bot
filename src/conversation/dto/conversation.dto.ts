// src/whatsapp/dto/conversation.dto.ts

import { IsString, IsNumber, IsArray, IsOptional, ValidateNested, IsEnum, IsDate, IsNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';
import { ObjectId } from 'mongodb';

export enum PaymentStatus {
  Pending = 'pending',
  Confirmed = 'confirmed',
  Partial = 'partial',
  Incomplete = 'incomplete',
}

export enum MessageType {
  User = 'user',
  Bot = 'bot',
  System = 'system',
}

export enum ConversationStep {
  Initial = 'initial',
  ProcessingOrder = 'processing_order',
  ConfirmOrder = 'confirm_order',
  SplitBill = 'split_bill',
  SplitBillNumber = 'split_bill_number',
  WaitingForContacts = 'waiting_for_contacts',
  ExtraTip = 'extra_tip',
  WaitingForPayment = 'waiting_for_payment',
  AwaitingUserDecision = 'awaiting_user_decision',
  PaymentReminder = 'payment_reminder',
  Feedback = 'feedback',
  FeedbackDetail = 'feedback_detail',
  Completed = 'completed',
  IncompleteOrder = 'incomplete_order',
  OrderNotFound = 'order_not_found',
  PaymentDeclined = 'payment_declined',
  PaymentInvalid = 'payment_invalid',
  PaymentAssistance = 'payment_assistance',
  OverpaymentDecision = 'overpayment_decision',
}

export class OrderDetailsDTO {
  @IsNumber()
  tableId: number;

  @IsArray()
  items: any[]; // Substitua `any` pelo tipo apropriado se conhecido

  @IsNumber()
  totalAmount: number;

  @IsNumber()
  @IsOptional()
  appliedDiscount?: number;
}


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

export class ContactDTO {
  @IsString()
  name: string;

  @IsString()
  phone: string;

  @IsNumber()
  individualAmount: number;
}

export class SplitInfoDTO {
  @IsNumber()
  numberOfPeople: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContactDTO)
  contacts: ContactDTO[];

  @IsOptional()
  @IsNumber()
  receivedContacts?: number;
}

export class PaymentDetailsDTO {
  @IsNumber()
  orderId: number;

  @IsNumber()
  totalDue: number;

  @IsNumber()
  @IsOptional()
  amountPaidSoFar?: number;

  @IsEnum(PaymentStatus)
  status: PaymentStatus;

  @IsNumber()
  initiatedAt: number;
}

export class FeedbackDTO {
  @IsNumber()
  @IsOptional()
  npsScore?: number;

  @IsString()
  @IsOptional()
  detailedFeedback?: string;
}

export class MessageDTO {
  @IsString()
  @IsNotEmpty()
  messageId: string;

  @IsString()
  @IsNotEmpty()
  content: string;

  @IsEnum(MessageType)
  type: MessageType;

  @IsDate()
  @Type(() => Date)
  timestamp: Date;

  @IsString()
  @IsOptional()
  senderId?: string; // ID of the sender (user or bot)
}


export class ConversationContextDTO {
  @IsEnum(ConversationStep)
  currentStep: ConversationStep;

  @ValidateNested()
  @Type(() => SplitInfoDTO)
  @IsOptional()
  splitInfo?: SplitInfoDTO;

  @ValidateNested()
  @Type(() => PaymentDetailsDTO)
  @IsOptional()
  paymentDetails?: PaymentDetailsDTO;

  @ValidateNested()
  @Type(() => FeedbackDTO)
  @IsOptional()
  feedback?: FeedbackDTO;

  @IsOptional()
  @IsNumber()
  paymentStartTime?: number;

  @IsOptional()
  @IsNumber()
  userAmount?: number;

  @IsOptional()
  @IsNumber()
  previousPayment?: number;

  @IsOptional()
  @IsNumber()
  excessPaymentAmount?: number;

  // New property to store payment proofs
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentProofDTO)
  @IsOptional()
  paymentProofs?: PaymentProofDTO[];

  // New property to store the timestamp of the last message
  @IsOptional()
  @IsDate()
  lastMessage?: Date;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MessageDTO)
  messages: MessageDTO[];
}

export class BaseConversationDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ValidateNested()
  @Type(() => OrderDetailsDTO)
  @IsOptional()
  orderDetails?: OrderDetailsDTO;

  @ValidateNested()
  @Type(() => ConversationContextDTO)
  conversationContext: ConversationContextDTO;
}

export class CreateConversationDto extends BaseConversationDto {
}

export class UpdateConversationDto extends BaseConversationDto {}

export class ConversationDto extends BaseConversationDto {
  @IsString()
  @IsNotEmpty()
  _id: ObjectId;
}