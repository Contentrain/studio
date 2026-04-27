import { runEnterpriseRoute } from '../../../../../../utils/enterprise'

export default defineEventHandler(event => runEnterpriseRoute('updateProjectConversationKey', 'conversation.upgrade', event, 'api.conversation'))
