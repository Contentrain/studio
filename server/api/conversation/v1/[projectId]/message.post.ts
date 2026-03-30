import { runEnterpriseRoute } from '../../../../utils/enterprise'

export default defineEventHandler(event => runEnterpriseRoute('handleConversationApiMessage', 'conversation.upgrade', event))
