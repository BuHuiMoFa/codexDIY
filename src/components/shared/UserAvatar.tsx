import { useSettingsStore } from '../../stores/settingsStore';

interface UserAvatarProps {
  size: string;
  rounded?: string;
  className?: string;
}

export function UserAvatar({ size, rounded = 'rounded-[10px]', className = '' }: UserAvatarProps) {
  const avatarUrl = useSettingsStore((s) => s.userAvatarUrl);
  const effectiveAvatarUrl = avatarUrl || '/app-icon.png';

  return (
    <div className={`${size} ${rounded}
      flex items-center justify-center flex-shrink-0 shadow-md overflow-hidden ${className}
      bg-transparent`}>
      <img src={effectiveAvatarUrl} alt="User" className="w-full h-full object-cover" />
    </div>
  );
}
