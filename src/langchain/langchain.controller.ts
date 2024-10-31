import { Controller, Get } from '@nestjs/common';
import { LangchainService } from './langchain.service';

@Controller('langchain')
export class LangchainController {
    constructor(private readonly langchainService: LangchainService) { }

    @Get("test")
    async test(): Promise<any> {
        return this.langchainService.testAnalyzePDF();
    }

}
