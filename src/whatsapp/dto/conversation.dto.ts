// src/whatsapp/dto/conversation.dto.ts

import { IsString, IsNumber, IsArray, IsOptional, ValidateNested, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

export enum PaymentStatus {
  Pending = 'pending',
  Confirmed = 'confirmed',
  Partial = 'partial',
  Incomplete = 'incomplete',
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
}

export class UserConversationDTO {
  @IsString()
  id: string;

  @ValidateNested()
  @Type(() => OrderDetailsDTO)
  @IsOptional()
  orderDetails?: OrderDetailsDTO;

  @ValidateNested()
  @Type(() => ConversationContextDTO)
  conversationContext: ConversationContextDTO;
}
