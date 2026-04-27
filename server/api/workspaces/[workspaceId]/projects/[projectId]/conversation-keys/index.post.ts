import { runEnterpriseRoute } from '../../../../../../utils/enterprise'

export default defineEventHandler(event => runEnterpriseRoute('createProjectConversationKey', 'conversation.upgrade', event, 'api.conversation'))
