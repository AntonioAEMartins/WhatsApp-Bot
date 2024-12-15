// src/whatsapp/dto/conversation.dto.ts

import { IsString, IsNumber, IsArray, IsOptional, ValidateNested, IsEnum, IsDate, IsNotEmpty, IsObject } from 'class-validator';
import { Type } from 'class-transformer';
import { ObjectId } from 'mongodb';


export class OrderItemDTO {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsNumber()
    price: number;

    @IsNumber()
    quantity: number;
}

export class BaseOrderDTO {
    @IsObject()
    @IsNotEmpty()
    _id?: ObjectId;

    @IsNumber()
    tableId: number;

    @IsArray()
    items: OrderItemDTO[];

    @IsNumber()
    totalAmount: number;

    @IsNumber()
    @IsOptional()
    appliedDiscount?: number;

    // Valor total já pago (somatório das transações confirmadas)
    @IsNumber()
    @IsOptional()
    amountPaidSoFar?: number;

    @IsOptional()
    @IsDate()
    createdAt?: Date;

    @IsOptional()
    updatedAt?: Date;
}

export class CreateOrderDTO extends BaseOrderDTO {

}

export class OrderDTO extends BaseOrderDTO {
    @IsObject()
    @IsNotEmpty()
    _id: ObjectId;
}