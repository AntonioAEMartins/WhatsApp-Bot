import { Process, Processor } from '@nestjs/bull';
import { RequestMessage, ResponseStructure, WhatsAppService } from './whatsapp.service';
import { ConversationDto } from 'src/conversation/dto/conversation.dto';
import { Job } from 'bull';

export class PaymentProcessorDTO {
  from: string;
  userMessage: string;
  state: ConversationDto;
  message: RequestMessage;
  mediaData: string;
  mediaType: string;
}


@Processor('payment')
export class PaymentProcessor {
  constructor(private readonly whatsAppService: WhatsAppService) { }

  @Process()
  async process(job: Job<PaymentProcessorDTO>): Promise<ResponseStructure[]> {
    try {
      // Aqui, pegue o retorno que você quer de fato
      const result = await this.whatsAppService.processPayment(job.data);
      return result;
    } catch (error) {
      throw error;
    }
  }
}
