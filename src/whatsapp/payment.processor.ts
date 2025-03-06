import { Process, Processor } from '@nestjs/bull';
import { RequestMessage, ResponseStructure, WhatsAppService } from './whatsapp.service';
import { ConversationDto } from 'src/conversation/dto/conversation.dto';
import { Job } from 'bull';

export class PaymentProcessorDTO {
  transactionId: string;
  from: string;
  state: ConversationDto;
}


@Processor('payment')
export class PaymentProcessor {
  constructor(private readonly whatsAppService: WhatsAppService) { }

  @Process()
  async process(job: Job<PaymentProcessorDTO>): Promise<void> {
    try {
      await new Promise(resolve => setTimeout(resolve, 3000)); // Must wait for the receipt to be sent
      await this.whatsAppService.processPayment(job.data)
    } catch (error) {
      throw error;
    }
  }
}
