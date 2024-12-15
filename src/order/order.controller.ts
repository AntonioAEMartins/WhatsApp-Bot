import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { OrderService } from './order.service';
import { CreateOrderDTO } from './dto/order.dto';
@Controller('order')
export class OrderController {
    constructor(private readonly orderService: OrderService) { }

    @HttpCode(HttpStatus.CREATED)
    @Post()
    async createOrder(@Body() order: CreateOrderDTO) {
        return await this.orderService.createOrder(order);
    }

    @HttpCode(HttpStatus.OK)
    @Get(':id')
    async getOrder(@Param('id') id: string) {
        return await this.orderService.getOrder(id);
    }

    @HttpCode(HttpStatus.OK)
    @Put(':id')
    async updateAmountPaidAndCheckOrderStatus(
        @Param('id') id: string,
        @Query('amountPaid') amountPaid: number
    ) {
        return await this.orderService.updateAmountPaidAndCheckOrderStatus(id, amountPaid);
    }

}