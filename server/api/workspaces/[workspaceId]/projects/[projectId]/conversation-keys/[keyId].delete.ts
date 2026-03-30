import { runEnterpriseRoute } from '../../../../../../utils/enterprise'

export default defineEventHandler(event => runEnterpriseRoute('deleteProjectConversationKey', 'conversation.upgrade', event))
