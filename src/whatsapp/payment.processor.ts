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
      // Aqui, pegue o retorno que você quer de fato
      await this.whatsAppService.processPayment(job.data)
    } catch (error) {
      throw error;
    }
  }
}
