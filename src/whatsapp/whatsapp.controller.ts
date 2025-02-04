// src/whatsapp/whatsapp.controller.ts

import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { RequestStructure, ResponseStructure, ResponseStructureExtended, WhatsAppService } from './whatsapp.service';


@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly whatsappService: WhatsAppService) { }

  @HttpCode(200)
  @Post('message')
  async receiveMessage(@Body() request: RequestStructure): Promise<ResponseStructure[]> {
    const response = await this.whatsappService.handleProcessMessage(request);

    // Group responses by the 'to' field
    const groupedResponses = response.reduce((acc, res) => {
      if (!acc[res.to]) {
        acc[res.to] = [];
      }
      acc[res.to].push(res);
      return acc;
    }, {} as Record<string, ResponseStructureExtended[]>);

    // Filter out messages for numbers with at least one error
    const filteredResponses = Object.values(groupedResponses).flatMap(responses => {
      const hasError = responses.some(res => res.isError);
      return hasError ? responses.filter(res => res.isError) : responses;
    });

    // Transform the filtered responses
    const transformedResponse: ResponseStructure[] = filteredResponses.map((res) => ({
      type: res.type,
      content: res.content,
      caption: res.caption,
      to: res.to,
      reply: res.reply,
    }));

    return transformedResponse;
  }

}
