export enum PaymentStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Denied = 'denied',
  Expired = 'expired',
  PreAuthorized = 'pre_authorized',
  Waiting = 'waiting',
  Created = 'created',
}

export enum PaymentDescription {
  Failed = 'failed',
}

export const ActivePaymentStatuses = [PaymentStatus.Pending];

export enum MessageType {
  User = 'user',
  Bot = 'bot',
  System = 'system',
}

export enum ConversationStep {
  Initial = 'initial',
  CollectName = 'collect_name',
  ProcessingOrder = 'processing_order',
  ConfirmOrder = 'confirm_order',
  SplitBill = 'split_bill',
  SplitBillNumber = 'split_bill_number',
  WaitingForContacts = 'waiting_for_contacts',
  ExtraTip = 'extra_tip',
  CollectCPF = 'collect_cpf',
  PixExpired = 'pix_expired',
  PaymentMethodSelection = 'payment_method_selection',
  WaitingForPayment = 'waiting_for_payment',
  AwaitingUserDecision = 'awaiting_user_decision',
  PaymentReminder = 'payment_reminder',
  CollectPhoneNumber = 'collect_phone_number',
  Feedback = 'feedback',
  FeedbackDetail = 'feedback_detail',
  Completed = 'completed',
  IncompleteOrder = 'incomplete_order',
  OrderNotFound = 'order_not_found',
  EmptyOrder = 'empty_order',
  PaymentDeclined = 'payment_declined',
  PaymentInvalid = 'payment_invalid',
  PaymentAssistance = 'payment_assistance',
  OverpaymentDecision = 'overpayment_decision',
  SelectSavedCard = 'select_saved_card',
  UserAbandoned = 'user_abandoned',
  DelayedPayment = 'delayed_payment',
  PIXError = 'pix_error',
}
