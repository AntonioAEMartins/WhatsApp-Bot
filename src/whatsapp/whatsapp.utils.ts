import { Injectable, Logger } from "@nestjs/common";
import { ConversationService } from "src/conversation/conversation.service";
import { ConversationDto } from "src/conversation/dto/conversation.dto";
import { LangchainService } from "src/langchain/langchain.service";
import { OrderService } from "src/order/order.service";
import { TableService } from "src/table/table.service";
import { PaymentProofDTO, TransactionDTO } from "src/transaction/dto/transaction.dto";
import { TransactionService } from "src/transaction/transaction.service";
import { UserService } from "src/user/user.service";
import { Client, LocalAuth, Message } from "whatsapp-web.js";
import { WhatsAppService } from "./whatsapp.service";


@Injectable()
export class WhatsAppUtils {

    private client: Client;
    private readonly logger = new Logger(WhatsAppService.name);

    constructor(
        private readonly tableService: TableService,
        private readonly langchainService: LangchainService,
        private readonly userService: UserService,
        private readonly conversationService: ConversationService,
        private readonly orderService: OrderService,
        private readonly transactionService: TransactionService,
    ) {
        this.client = new Client({
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            },
            authStrategy: new LocalAuth({
                clientId: 'coti-payments',
            }),
        });
    }

    /**
     * Utility: User Sent Proof
     *
     * Checks if the user's message indicates that a payment proof (textual mention or media) was sent.
     *
     * @param userMessage - The text message sent by the user.
     * @param message - The received WhatsApp message object.
     * @returns A boolean indicating whether the user sent payment proof.
     *
     * Functionality:
     * - Returns true if 'comprovante' is mentioned or if the message has media.
     */
    public userSentProof(userMessage: string, message: Message): boolean {
        return userMessage.includes('comprovante') || message.hasMedia;
    }

    /**
     * Utility: Build Payment Data
     *
     * Retrieves the active transaction for the user and calculates the amount paid from the analysis result.
     *
     * @param state - The current state of the user's conversation.
     * @param analysisResult - The analyzed payment proof details.
     * @returns A Promise that resolves to an object containing the active transaction and the amount paid.
     *
     * Functionality:
     * - Fetches the user's last active transaction.
     * - Extracts the amountPaid from the analysisResult.
     */
    public async buildPaymentData(
        state: ConversationDto,
        analysisResult: PaymentProofDTO,
    ): Promise<{ activeTransaction: TransactionDTO; amountPaid: number }> {
        const { data: activeTransaction } = await this.transactionService.getLastActiveTransactionByUserId(state.userId);
        const amountPaid = parseFloat(analysisResult.valor?.toString() || '0');
        return { activeTransaction, amountPaid };
    }

    /**
     * Utility: Validate Beneficiary
     *
     * Checks if the payment proof beneficiary matches the expected beneficiary.
     *
     * @param analysisResult - The analyzed payment proof details.
     * @returns A boolean indicating whether the beneficiary is correct.
     *
     * Functionality:
     * - Validates the beneficiary name or CNPJ against the expected values.
     */
    public validateBeneficiary(analysisResult: PaymentProofDTO): boolean {
        const expectedBeneficiary = 'EMPORIO CRISTOVAO';
        const expectedCNPJ = '42.081.641/0001-68';

        const beneficiaryNameMatches = analysisResult.nome_beneficiario
            ?.toUpperCase()
            .includes(expectedBeneficiary);
        const cnpjMatches = analysisResult.cpf_cnpj_beneficiario === expectedCNPJ;

        return beneficiaryNameMatches || cnpjMatches;
    }

    /**
     * Utility: Extract and Analyze Payment Proof
     *
     * Extracts text from a PDF payment proof and analyzes it to retrieve transaction details.
     *
     * @param pdfData - The raw PDF data representing the payment proof.
     * @param state - The current state of the user's conversation.
     * @returns A Promise that resolves to a PaymentProofDTO with extracted transaction details.
     *
     * Functionality:
     * - Uses OCR/extraction service to read PDF content.
     * - Analyzes the extracted text to identify payment info.
     */
    public async extractAndAnalyzePaymentProof(
        pdfData: string,
        state: ConversationDto,
    ): Promise<PaymentProofDTO> {
        const extractedText = await this.langchainService.extractTextFromPDF(pdfData);
        return await this.langchainService.analyzeDocument(extractedText, state.conversationContext.userAmount);
    }

}