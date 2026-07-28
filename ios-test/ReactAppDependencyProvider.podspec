Pod::Spec.new do |s|
  s.name = 'ReactAppDependencyProvider'
  s.version = '0.1.0'
  s.summary = 'Generated dependency provider'
  s.homepage = 'https://expo.dev'
  s.license = 'MIT'
  s.author = 'Expo'
  s.source = { :git => '', :tag => '0.1.0' }
  s.platforms = { :ios => '15.0' }
  s.source_files = '**/*.{h,m,mm,cpp}'
  s.dependency 'React-Core'
end
