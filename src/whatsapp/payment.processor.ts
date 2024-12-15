import { Process, Processor } from '@nestjs/bull';
import { WhatsAppService } from './whatsapp.service';
import { ConversationDto } from 'src/conversation/dto/conversation.dto';
import { Message } from 'whatsapp-web.js';
import { Job } from 'bull';

export class PaymentProcessorDTO {
  from: string;
  userMessage: string;
  state: ConversationDto;
  message: Message;
  mediaData: string;
  mediaType: string;
}


@Processor('payment')
export class PaymentProcessor {
  constructor(private readonly whatsAppService: WhatsAppService) {

  }

  @Process()
  async process(job: Job<PaymentProcessorDTO>): Promise<void> {
    try {
      // console.log('Processing job:', job.id, job.data);
      await this.whatsAppService.processPayment(job.data);
      // console.log('Job completed successfully');
    } catch (error) {
      // console.error('Job processing failed:', error);
      throw error; // Rejeita o job para o BullMQ lidar
    }
  }
}