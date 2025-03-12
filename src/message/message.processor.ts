import { Process, Processor } from '@nestjs/bull';
import { MessageService, RequestStructure, ResponseStructureExtended } from './message.service';
import { Job } from 'bull';

@Processor('message')
export class MessageProcessor {
    constructor(private readonly messageService: MessageService) { }

    @Process('message')
    async process(job: Job<RequestStructure>): Promise<ResponseStructureExtended[]> {
        try {
            console.log('Processing message:', job.data);
            return await this.messageService.handleProcessMessage(job.data)
        } catch (error) {
            throw error;
        }
    }
}
