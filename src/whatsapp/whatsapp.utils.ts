import { Injectable, Logger } from "@nestjs/common";
import { ConversationService } from "src/conversation/conversation.service";
import { ConversationDto, ParticipantDTO } from "src/conversation/dto/conversation.dto";
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

    /**
     * Utility: Check if Message Contains vCard
     *
     * Determines whether a given message is of type 'vcard' or 'multi_vcard'.
     *
     * @param message - The message object to evaluate.
     * @returns A boolean indicating whether the message contains vCard data.
     *
     * Functionality:
     * - Verifies the type of the message to check for vCard content.
     * - Supports both single and multiple vCard types.
     */

    public isVcardMessage(message: Message): boolean {
        return message.type === 'vcard' || message.type === 'multi_vcard';
    }

    /**
     * Utility: Calculate Remaining Contacts Needed
     *
     * Calculates the number of contacts still needed to complete the payment split process.
     *
     * @param state - The current state of the user's conversation.
     * @returns An object containing:
     *          - `contactsNeeded`: The total number of contacts required for the split.
     *          - `remainingContactsNeeded`: The number of contacts still required.
     *          - `totalContactsExpected`: The total number of expected contacts based on the number of people.
     *
     * Functionality:
     * - Retrieves the number of contacts already provided.
     * - Computes the total contacts expected from the split information.
     * - Calculates how many more contacts are required to proceed.
     */

    public calculateContactsNeeded(state: ConversationDto): {
        contactsNeeded: number;
        remainingContactsNeeded: number;
        totalContactsExpected: number;
    } {
        const contactsReceivedSoFar = state.conversationContext.splitInfo.participants.length;
        const totalContactsExpected = state.conversationContext.splitInfo.numberOfPeople - 1;
        const remainingContactsNeeded = totalContactsExpected - contactsReceivedSoFar;

        return {
            contactsNeeded: totalContactsExpected,
            remainingContactsNeeded,
            totalContactsExpected,
        };
    }

    /**
     * Utility: Extract Contacts from vCards
     *
     * Extracts contact details from a vCard message, limiting the number of contacts based on the required count.
     *
     * @param message - The message object containing the vCards.
     * @param remainingContactsNeeded - The number of contacts still required for the split.
     * @returns An array of objects representing the extracted contacts, each containing:
     *          - `name`: The name of the contact from the vCard (or a default value if not provided).
     *          - `phone`: The sanitized phone number of the contact.
     *          - `individualAmount`: Default value initialized to 0.
     *
     * Functionality:
     * - Limits the number of processed vCards to the required count.
     * - Extracts the contact's name and phone number from the vCard data.
     * - Sanitizes phone numbers by removing non-numeric characters.
     */

    public extractContactsFromVcards(message: Message, remainingContactsNeeded: number): ParticipantDTO[] {
        const vcardDataArray = message.vCards;
        const vcardDataArrayLimited = vcardDataArray.slice(0, remainingContactsNeeded);

        return vcardDataArrayLimited.map((vcardData) => {
            const vcardName = vcardData.split('FN:')[1]?.split('\n')[0] || 'Nome não informado';
            let vcardPhone = vcardData.split('waid=')[1]?.split(':')[1]?.split('\n')[0] || '';
            vcardPhone = vcardPhone.replace(/\D/g, '');

            const participant: ParticipantDTO = {
                name: vcardName,
                phone: vcardPhone,
                expectedAmount: 0,
                paidAmount: 0
            }

            return participant;
        });
    }

    /**
     * Utility: Add Extracted Contacts to State
     *
     * Updates the conversation state by appending extracted contacts to the existing list.
     *
     * @param state - The current state of the user's conversation.
     * @param contacts - An array of contact objects to be added, each containing:
     *                   - `name`: The name of the contact.
     *                   - `phone`: The phone number of the contact.
     *                   - `individualAmount`: The amount associated with the contact (defaulted to 0).
     *
     * Functionality:
     * - Appends the provided contacts to the `contacts` array in the `splitInfo` section of the conversation state.
     * - Ensures the state accurately reflects all received contacts.
     */

    public addExtractedContactsToState(
        state: ConversationDto,
        contacts: ParticipantDTO[]
    ): void {
        state.conversationContext.splitInfo.participants.push(...contacts);
    }

    /**
     * Utility: Check if All Contacts Are Received
     *
     * Determines whether the required number of contacts for the payment split has been received.
     *
     * @param state - The current state of the user's conversation.
     * @param totalContactsExpected - The total number of contacts expected based on the split requirements.
     * @returns A boolean indicating whether all required contacts have been received.
     *
     * Functionality:
     * - Compares the number of contacts already provided with the total number of contacts expected.
     * - Returns `true` if the required contacts are equal to or exceed the expected count, otherwise `false`.
     */

    public haveAllContacts(state: ConversationDto, totalContactsExpected: number): boolean {
        return state.conversationContext.splitInfo.participants.length >= totalContactsExpected;
    }
}