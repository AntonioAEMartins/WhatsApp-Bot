// src/whatsapp/dto/conversation.dto.ts

import { IsString, IsNumber, IsArray, IsOptional, ValidateNested, IsEnum, IsDate, IsNotEmpty, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { ObjectId } from 'mongodb';
import { ConversationStep, MessageType, PaymentStatus } from './conversation.enums';
import { PaymentMethod } from 'src/transaction/dto/transaction.dto';
import { CardDto } from 'src/card/dto/card.dto';




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
  senderId?: string;
}

export class ParticipantDTO {
  @IsString()
  name: string;

  @IsString()
  phone: string;

  @IsNumber()
  expectedAmount: number;

  @IsNumber()
  paidAmount: number;
}

export class SplitInfoDTO {
  @IsNumber()
  numberOfPeople: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ParticipantDTO)
  participants: ParticipantDTO[];

  @IsOptional()
  @IsNumber()
  receivedContacts?: number;
}



export class FeedbackDTO {
  @IsNumber()
  @IsOptional()
  mustHaveScore?: string;

  @IsString()
  @IsOptional()
  detailedFeedback?: string;

  @IsString()
  @IsOptional()
  recommendedRestaurants?: string;
}

export class ConversationContextDTO {
  @IsEnum(ConversationStep)
  currentStep: ConversationStep;

  // Informações sobre divisão de conta
  @ValidateNested()
  @Type(() => SplitInfoDTO)
  @IsOptional()
  splitInfo?: SplitInfoDTO;

  // Feedback do usuário durante/ao final da conversa
  @ValidateNested()
  @Type(() => FeedbackDTO)
  @IsOptional()
  feedback?: FeedbackDTO;

  @IsOptional()
  @IsNumber()
  paymentStartTime?: number;

  @IsOptional()
  @IsNumber()
  totalOrderAmount?: number;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'cpf deve conter apenas números.' })
  documentNumber?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsNumber()
  userAmount?: number;

  @IsOptional()
  @IsNumber()
  tipAmount?: number;

  @IsOptional()
  @IsNumber()
  tipPercent?: number;

  @IsOptional()
  @IsNumber()
  excessPaymentAmount?: number;

  @IsOptional()
  @IsNumber()
  underPaymentAmount?: number;

  // Última mensagem registrada
  @IsOptional()
  @IsDate()
  lastMessage?: Date;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MessageDTO)
  messages: MessageDTO[];

  @IsEnum(PaymentMethod)
  @IsOptional()
  paymentMethod?: PaymentMethod;

  @IsString()
  @IsOptional()
  userName?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CardDto)
  savedCards?: CardDto[];

  @IsString()
  @IsOptional()
  selectedCardId?: string;
}

export class BaseConversationDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsOptional()
  orderId?: string;

  @IsString()
  @IsOptional()
  tableId?: string;

  @IsString()
  @IsOptional()
  referrerUserId?: string;

  @ValidateNested()
  @Type(() => ConversationContextDTO)
  conversationContext: ConversationContextDTO;
}

export class CreateConversationDto extends BaseConversationDto {
}

export class ConversationDto extends BaseConversationDto {
  @IsString()
  @IsNotEmpty()
  _id: ObjectId;

  @IsOptional()
  createdAt?: Date;

  @IsOptional()
  updatedAt?: Date;
}

