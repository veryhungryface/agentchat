import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function ChatMessage({ message, isStreaming }) {
  const isUser = message.role === 'user';

  return (
    <div className={`message ${isUser ? 'message-user' : 'message-assistant'} ${message.isError ? 'message-error' : ''}`}>
      <div className="message-avatar">
        {isUser ? 'U' : 'AI'}
      </div>
      <div className="message-content">
        {message.content ? (
          isUser ? (
            message.content
          ) : (
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            </div>
          )
        ) : (
          isStreaming ? <span className="cursor-blink" /> : null
        )}
      </div>
    </div>
  );
}

export default ChatMessage;
