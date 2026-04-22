import { runEnterpriseRoute } from '../../../../../../utils/enterprise'

export default defineEventHandler(event => runEnterpriseRoute('listProjectConversationKeys', 'conversation.upgrade', event, 'api.conversation'))
