import { runEnterpriseRoute } from '../../../../utils/enterprise'

export default defineEventHandler(event => runEnterpriseRoute('handleConversationApiHistory', 'conversation.upgrade', event))
