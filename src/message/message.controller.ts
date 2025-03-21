import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { MessageService, RequestStructure, ResponseStructure, ResponseStructureExtended } from './message.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { SimpleResponseDto } from 'src/request/request.dto';


@Controller('message')
export class MessageController {
  constructor(private readonly messageService: MessageService) { }

  @HttpCode(200)
  @Post('message')
  async receiveMessage(@Body() request: RequestStructure): Promise<ResponseStructure[]> {
    const response = await this.messageService.handleProcessMessage(request);

    const groupedResponses = response.reduce((acc, res) => {
      if (!acc[res.to]) {
        acc[res.to] = [];
      }
      acc[res.to].push(res);
      return acc;
    }, {} as Record<string, ResponseStructureExtended[]>);

    const filteredResponses = Object.values(groupedResponses).flatMap(responses => {
      const hasError = responses.some(res => res.isError);
      return hasError ? responses.filter(res => res.isError) : responses;
    });

    const transformedResponse: ResponseStructure[] = filteredResponses.map((res) => ({
      type: res.type,
      content: res.content,
      caption: res.caption,
      to: res.to,
      reply: res.reply,
    }));

    return transformedResponse;
  }

  @Post('receipt')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  async receiveReceipt(
    @UploadedFile() file: Express.Multer.File,
    @Body('transactionId') transactionId: string,
  ): Promise<SimpleResponseDto<string>> {
    const response = await this.messageService.processReceipt(file, transactionId);
    return {
      msg: 'Receipt received',
      data: response,
    };
  }

  @Get('table-payment-complete-message/:conversationId')
  async notifyWaiterTablePaymentComplete(@Param('conversationId') conversationId: string): Promise<SimpleResponseDto<ResponseStructureExtended[]>> {
    const response = await this.messageService.notifyWaiterTablePaymentComplete(null, conversationId);
    return {
      msg: 'Notification sent',
      data: response,
    };
  }

  @Get('wrong-order-message/:tableNumber')
  async notifyWaiterWrongOrder(@Param('tableNumber') tableNumber: number): Promise<SimpleResponseDto<ResponseStructureExtended[]>> {
    const response = await this.messageService.notifyWaiterWrongOrder(tableNumber);
    return {
      msg: 'Notification sent',
      data: response,
    };
  }

  @Get('table-started-payment-message/:tableNumber')
  async notifyWaiterTableStartedPayment(@Param('tableNumber') tableNumber: number): Promise<SimpleResponseDto<ResponseStructureExtended[]>> {
    const response = await this.messageService.notifyWaiterTableStartedPayment(tableNumber);
    return {
      msg: 'Notification sent',
      data: response,
    };
  }
}