import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { TransactionService } from './transaction.service';
import { CreateTransactionDTO } from './dto/transaction.dto';
@Controller('transaction')
export class TransactionController {
    constructor(private readonly transactionService: TransactionService) { }

    @HttpCode(HttpStatus.CREATED)
    @Post()
    async createTransaction(@Body() transaction: CreateTransactionDTO) {
        return await this.transactionService.createTransaction(transaction);
    }

    @HttpCode(HttpStatus.OK)
    @Get(':id')
    async getTransaction(@Param('id') id: string) {
        return await this.transactionService.getTransaction(id);
    }

    @HttpCode(HttpStatus.OK)
    @Get('active_by_order')
    async getActiveTransactionsByOrderId(@Query('orderId') orderId: string) {
        if (!orderId) {
            throw new HttpException("Order ID is required", HttpStatus.BAD_REQUEST);
        }

        const numericOrderId = parseInt(orderId, 10);
        if (isNaN(numericOrderId)) {
            throw new HttpException("Order ID must be a valid number", HttpStatus.BAD_REQUEST);
        }

        return await this.transactionService.getActiveTransactionsByOrderId(orderId);
    }

    @HttpCode(HttpStatus.OK)
    @Get('active_by_user')
    async getActiveTransactionsByUserId(@Query('userId') userId: string) {
        if (!userId) {
            throw new HttpException("User ID is required", HttpStatus.BAD_REQUEST);
        }

        return await this.transactionService.getActiveTransactionsByUserId(userId);
    }

    @HttpCode(HttpStatus.OK)
    @Post(":id/completed")
    async completeTransaction(@Param('id') id: string) {
        return await this.transactionService.completeTransaction(id);
    }
   
}